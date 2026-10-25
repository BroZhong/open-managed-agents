import type { Pool } from "./connection.js";
import { DEFAULT_SCHEMA } from "./connection.js";

/**
 * DDL for the Server control plane + event log, under the `oma` schema.
 *
 * JSON-ish columns (agent config, event payloads, snapshots) are stored as
 * JSONB. The event log's atomic per-session sequence is backed by the
 * `event_counters` table and an UPDATE ... RETURNING inside the same
 * transaction as the INSERT (see PgEventLogStore).
 */
export function schemaDdl(schema: string = DEFAULT_SCHEMA): string {
  const s = `"${schema}"`;
  return `
CREATE SCHEMA IF NOT EXISTS ${s};

CREATE TABLE IF NOT EXISTS ${s}.model_providers (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  config JSONB NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS ${s}.session_shares (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS ${s}.agents (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  model        TEXT NOT NULL,
  thinking     TEXT,
  system       TEXT NOT NULL,
  runtime      TEXT NOT NULL,
  tools        JSONB,
  mcp_servers  JSONB,
  skills       JSONB,
  sandbox      JSONB,
  created_at   TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL
);
ALTER TABLE ${s}.agents ADD COLUMN IF NOT EXISTS thinking TEXT;
-- The Environment (ADR-0024) the Agent's new Sessions run in; NULL: none.
ALTER TABLE ${s}.agents ADD COLUMN IF NOT EXISTS environment_id TEXT;
CREATE INDEX IF NOT EXISTS agents_tenant_id_idx ON ${s}.agents (tenant_id, id);

CREATE TABLE IF NOT EXISTS ${s}.loops (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  agent_id          TEXT NOT NULL,
  name              TEXT NOT NULL,
  description       TEXT,
  prompt            TEXT NOT NULL,
  interval_minutes  INTEGER NOT NULL CHECK (interval_minutes >= 5),
  enabled           BOOLEAN NOT NULL,
  next_run_at       TIMESTAMPTZ NOT NULL,
  last_run_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS loops_tenant_agent_idx ON ${s}.loops (tenant_id, agent_id, created_at);
CREATE INDEX IF NOT EXISTS loops_due_idx ON ${s}.loops (next_run_at) WHERE enabled = true;

-- Agent Files are small editable markdown documents (IDENTITY, SOUL, USER,
-- MEMORY) that shape an Agent's persona/instructions, isolated per
-- (tenant_id, agent_id). They are part of the Agent, never a Session's
-- Workspace — Agent Files never touch a Session's Workspace/S3.
CREATE TABLE IF NOT EXISTS ${s}.agent_files (
  tenant_id   TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  filename    TEXT NOT NULL,
  content     TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, agent_id, filename)
);

-- Skills are reusable, instruction-only capabilities (a directory with a
-- SKILL.md). Metadata lives here; file bodies live in S3 under
-- <tenantId>/skills/<skillId>/… (isolated from Workspace prefixes).
--
-- Every Skill has an owner (ADR-0004):
--   owner_type='library'  → a Library Skill, owned by the tenant (owner_id =
--                           tenant_id). Listed in the Skill Library.
--   owner_type='agent'    → an Agent Skill (a Skill Fork), owned by one Agent
--                           (owner_id = agentId). Produced when a Library Skill
--                           is equipped; records source_skill_id = the Library
--                           Skill it was forked from. Independent thereafter.
-- Agent.skills holds Agent Skill (fork) ids, never Library Skill ids.
CREATE TABLE IF NOT EXISTS ${s}.skills (
  skill_id        TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL,
  owner_type      TEXT NOT NULL DEFAULT 'library',
  owner_id        TEXT NOT NULL DEFAULT '',
  source_skill_id TEXT,
  created_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL,
  bundle_sha256   TEXT,
  bundle_size     BIGINT,
  PRIMARY KEY (tenant_id, skill_id)
);
CREATE INDEX IF NOT EXISTS skills_tenant_id_idx ON ${s}.skills (tenant_id, skill_id);
CREATE INDEX IF NOT EXISTS skills_owner_idx ON ${s}.skills (tenant_id, owner_type, owner_id);

-- Migration for skills predating ADR-0004 (owner columns added above via
-- CREATE TABLE for fresh installs; ALTER for existing tables). Backfill:
-- every pre-existing Skill was a Library Skill owned by its tenant.
ALTER TABLE ${s}.skills ADD COLUMN IF NOT EXISTS owner_type      TEXT NOT NULL DEFAULT 'library';
ALTER TABLE ${s}.skills ADD COLUMN IF NOT EXISTS owner_id        TEXT NOT NULL DEFAULT '';
ALTER TABLE ${s}.skills ADD COLUMN IF NOT EXISTS source_skill_id TEXT;
UPDATE ${s}.skills SET owner_id = tenant_id WHERE owner_type = 'library' AND owner_id = '';

-- Preserve unknown upload times for legacy Skills; updated_at is not creation time.
ALTER TABLE ${s}.skills ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

-- The current Skill Bundle (ADR-0022): sha256 of the immutable zip and its
-- total uncompressed size, set together. NULL until the Skill is packed.
ALTER TABLE ${s}.skills ADD COLUMN IF NOT EXISTS bundle_sha256 TEXT;
ALTER TABLE ${s}.skills ADD COLUMN IF NOT EXISTS bundle_size   BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS skills_owner_name_unique
  ON ${s}.skills (tenant_id, owner_type, owner_id, name);

-- Workspaces are tenant-owned; the OSS-backed home of a Session's
-- artifacts. A user-supplied id is used as-is, else auto-generated. The
-- (tenant_id, id) PK makes binding to a user-supplied id idempotent so many
-- Sessions can share one Workspace concurrently. See ADR-0002 §4.
CREATE TABLE IF NOT EXISTS ${s}.workspaces (
  id          TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  name        TEXT,
  created_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS ${s}.sessions (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  agent_id       TEXT NOT NULL,
  status         TEXT NOT NULL,
  title          TEXT,
  agent          JSONB NOT NULL,
  workspace_id   TEXT NOT NULL,
  loop_id        TEXT,
  created_at     TIMESTAMPTZ NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL,
  terminated_at  TIMESTAMPTZ
);
ALTER TABLE ${s}.workspaces ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS thinking TEXT;
ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS loop_id TEXT;
ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS delegation JSONB;
-- The Environment the Session is frozen to at creation (ADR-0024); NULL: none.
ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS environment_id TEXT;

-- One coordination lock orders quota admissions and multi-row transitions.
CREATE TABLE IF NOT EXISTS ${s}.delegation_lock (id TEXT PRIMARY KEY);
INSERT INTO ${s}.delegation_lock (id) VALUES ('coordination') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS ${s}.delegation_executions (id TEXT PRIMARY KEY, record JSONB NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS delegation_caller_identity_idx ON ${s}.delegation_executions
  ((record->>'tenantId'), (record->>'callerSessionId'), (record->>'callerTurnId'), (record->>'callerToolUseId'));
CREATE UNIQUE INDEX IF NOT EXISTS delegation_pending_identity_idx ON ${s}.delegation_executions ((record->>'pendingEventId'));
CREATE INDEX IF NOT EXISTS delegation_child_idx ON ${s}.delegation_executions ((record->>'tenantId'), (record->>'childId'));
CREATE INDEX IF NOT EXISTS delegation_caller_idx ON ${s}.delegation_executions ((record->>'tenantId'), (record->>'callerSessionId'));
CREATE TABLE IF NOT EXISTS ${s}.delegation_waits (id TEXT PRIMARY KEY, record JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS ${s}.delegation_commands (id TEXT PRIMARY KEY, record JSONB NOT NULL);
-- Delegation rows are never pruned, yet they are read on every tool result,
-- every Child heartbeat and every pending scan of every Runner. The open-state
-- partial indexes are keyed by id: termination reconciliation reads them in id order.
CREATE INDEX IF NOT EXISTS delegation_waits_input_idx ON ${s}.delegation_waits ((record->>'callerSessionId'), (record->>'parentPendingEventId'));
CREATE INDEX IF NOT EXISTS delegation_waits_waiting_idx ON ${s}.delegation_waits (id) WHERE record->>'status' = 'waiting';
CREATE INDEX IF NOT EXISTS delegation_commands_execution_idx ON ${s}.delegation_commands ((record->>'executionId'));
CREATE INDEX IF NOT EXISTS delegation_executions_open_idx ON ${s}.delegation_executions (id) WHERE record->>'status' IN ('queued', 'running');
CREATE TABLE IF NOT EXISTS ${s}.delegation_resource_uses (id TEXT PRIMARY KEY, record JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS ${s}.delegation_environments (id TEXT PRIMARY KEY, sandbox_id TEXT);
ALTER TABLE ${s}.delegation_environments ADD COLUMN IF NOT EXISTS reclaiming BOOLEAN NOT NULL DEFAULT FALSE;
-- The binding records intent (ADR-0023): Creating since this time, by the
-- database clock, while sandbox_id is NULL; past the intent deadline any
-- Runner reconciles it with the gateway. NULL when Ready or Cold.
ALTER TABLE ${s}.delegation_environments ADD COLUMN IF NOT EXISTS creating_since TIMESTAMPTZ;
-- What the Session API reports of the binding (ADR-0023): when its state
-- began, by the database clock (its last move, its first Sandbox
-- unavailability since, or its recovery; NULL before its first move), and the
-- last Sandbox unavailability observed in that state: code, reason and time.
-- A move or a preparation that ends ready clears the failure.
ALTER TABLE ${s}.delegation_environments ADD COLUMN IF NOT EXISTS state_since TIMESTAMPTZ;
ALTER TABLE ${s}.delegation_environments ADD COLUMN IF NOT EXISTS last_error_code TEXT;
ALTER TABLE ${s}.delegation_environments ADD COLUMN IF NOT EXISTS last_error_reason TEXT;
ALTER TABLE ${s}.delegation_environments ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMPTZ;
-- The last complete Skill Install (ADR-0022): the Sandbox it went into, the
-- Skill Set hash it installed and its /skills switch generation in that
-- Sandbox. All NULL until one is recorded.
ALTER TABLE ${s}.delegation_environments ADD COLUMN IF NOT EXISTS skills_sandbox_id TEXT;
ALTER TABLE ${s}.delegation_environments ADD COLUMN IF NOT EXISTS skills_set_hash TEXT;
ALTER TABLE ${s}.delegation_environments ADD COLUMN IF NOT EXISTS skills_generation BIGINT;
-- What sandbox_id was created with (ADR-0024): its Session's Environment and
-- the image it was claimed with. Set with sandbox_id by the move to Ready
-- that recorded its creation, NULL with it, and NULL for a Sandbox adopted
-- by reconciliation.
ALTER TABLE ${s}.delegation_environments ADD COLUMN IF NOT EXISTS environment_id TEXT;
ALTER TABLE ${s}.delegation_environments ADD COLUMN IF NOT EXISTS image TEXT;
CREATE INDEX IF NOT EXISTS sessions_tenant_id_idx ON ${s}.sessions (tenant_id, id);
CREATE INDEX IF NOT EXISTS sessions_agent_id_idx ON ${s}.sessions (agent_id);
CREATE INDEX IF NOT EXISTS sessions_workspace_id_idx ON ${s}.sessions (tenant_id, workspace_id);
CREATE INDEX IF NOT EXISTS sessions_loop_id_idx ON ${s}.sessions (tenant_id, loop_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ${s}.event_counters (
  session_id  TEXT PRIMARY KEY,
  seq         BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ${s}.events (
  session_id         TEXT NOT NULL,
  seq                BIGINT NOT NULL,
  type               TEXT NOT NULL,
  data               JSONB,
  ts                 TIMESTAMPTZ NOT NULL,
  session_thread_id  TEXT NOT NULL,
  api_key_id         TEXT,
  idempotency_key    TEXT,
  PRIMARY KEY (session_id, seq)
);
ALTER TABLE ${s}.events ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE ${s}.events ADD COLUMN IF NOT EXISTS api_key_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS events_session_idempotency_key_uidx
  ON ${s}.events (session_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_session_usage_idx
  ON ${s}.events (session_id, seq)
  WHERE type = 'span.model_request_end';
CREATE INDEX IF NOT EXISTS events_api_key_usage_idx
  ON ${s}.events (api_key_id, session_id, seq)
  WHERE type = 'span.model_request_end' AND api_key_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ${s}.pending_events (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL,
  type               TEXT NOT NULL,
  data               JSONB,
  session_thread_id  TEXT NOT NULL,
  api_key_id         TEXT,
  arrived_at         TIMESTAMPTZ NOT NULL,
  seq                BIGSERIAL,
  claim_owner        TEXT,
  claim_expires_at   TIMESTAMPTZ,
  claim_generation   BIGINT NOT NULL DEFAULT 0
);
ALTER TABLE ${s}.pending_events ADD COLUMN IF NOT EXISTS interrupt_requested_at TIMESTAMPTZ;
ALTER TABLE ${s}.pending_events ADD COLUMN IF NOT EXISTS interrupt_generation BIGINT;
ALTER TABLE ${s}.pending_events ADD COLUMN IF NOT EXISTS api_key_id TEXT;
ALTER TABLE ${s}.pending_events ADD COLUMN IF NOT EXISTS claim_owner TEXT;
ALTER TABLE ${s}.pending_events ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ;
ALTER TABLE ${s}.pending_events ADD COLUMN IF NOT EXISTS claim_generation BIGINT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS pending_events_session_idx ON ${s}.pending_events (session_id, seq);

CREATE TABLE IF NOT EXISTS ${s}.session_cleanup (
  session_id TEXT PRIMARY KEY,
  retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS session_cleanup_retry_idx ON ${s}.session_cleanup (retry_at) WHERE completed_at IS NULL;

CREATE TABLE IF NOT EXISTS ${s}.api_keys (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  key_hash    TEXT NOT NULL UNIQUE,
  prefix      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ
);
ALTER TABLE ${s}.api_keys ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS api_keys_tenant_id_idx ON ${s}.api_keys (tenant_id);

CREATE TABLE IF NOT EXISTS ${s}.users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON ${s}.users (lower(username));

-- Environments (ADR-0024): a Base Image, an init script and variables, built
-- once into the image that serves Sandboxes. Built-in Environments have
-- owner_type 'platform', no tenant and a fixed id. env holds plain values and
-- secret references; secrets holds the Tenant secrets' ciphertexts by key.
-- image is the digest serving Sandboxes (NULL until a build first succeeds);
-- last_build_id is the most recent build. Deletion is soft.
CREATE TABLE IF NOT EXISTS ${s}.environments (
  id             TEXT PRIMARY KEY,
  owner_type     TEXT NOT NULL CHECK (owner_type IN ('platform', 'tenant')),
  tenant_id      TEXT,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL,
  base_image     TEXT NOT NULL,
  init_script    TEXT NOT NULL,
  env            JSONB NOT NULL,
  secrets        JSONB NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('pending', 'building', 'failed', 'ready')),
  image          TEXT,
  manifest       JSONB,
  last_build_id  TEXT,
  created_at     TIMESTAMPTZ NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL,
  deleted_at     TIMESTAMPTZ,
  CHECK ((owner_type = 'platform') = (tenant_id IS NULL))
);
-- Names are unique per owner among Environments that are not deleted.
CREATE UNIQUE INDEX IF NOT EXISTS environments_tenant_name_unique
  ON ${s}.environments (tenant_id, name) WHERE owner_type = 'tenant' AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS environments_platform_name_unique
  ON ${s}.environments (owner_type, name) WHERE owner_type = 'platform' AND deleted_at IS NULL;

-- Environment Builds, written in the transaction that changes the Environment
-- (ADR-0018: the API executes nothing). A row snapshots what to build; the
-- image builder claims a pending row, or a running one whose lease expired,
-- by lease_owner/lease_expires_at, and records its outcome. A newer change, or
-- deleting the Environment, supersedes the active build. seq orders builds.
CREATE TABLE IF NOT EXISTS ${s}.environment_builds (
  id                 TEXT PRIMARY KEY,
  seq                BIGSERIAL,
  environment_id     TEXT NOT NULL,
  owner_type         TEXT NOT NULL,
  tenant_id          TEXT,
  status             TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'superseded')),
  base_image         TEXT NOT NULL,
  init_script        TEXT NOT NULL,
  definition_sha256  TEXT NOT NULL,
  base_image_digest  TEXT,
  attempts           INTEGER NOT NULL DEFAULT 0,
  lease_owner        TEXT,
  lease_expires_at   TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL,
  started_at         TIMESTAMPTZ,
  finished_at        TIMESTAMPTZ,
  error_code         TEXT,
  error_message      TEXT,
  image              TEXT,
  manifest           JSONB,
  log_key            TEXT
);
-- An Environment's builds; then at most one active build per Environment.
-- (pg-mem serves a lookup from the first index on its columns, ignoring a
-- partial index's predicate, so the plain index comes first.)
CREATE INDEX IF NOT EXISTS environment_builds_environment_idx
  ON ${s}.environment_builds (environment_id);
CREATE UNIQUE INDEX IF NOT EXISTS environment_builds_active_unique
  ON ${s}.environment_builds (environment_id) WHERE status IN ('pending', 'running');
-- The builder's claim scan, oldest first.
CREATE INDEX IF NOT EXISTS environment_builds_claim_idx
  ON ${s}.environment_builds (seq) WHERE status IN ('pending', 'running');
`;
}

/** Create the schema and all tables if they do not exist. */
export async function ensureSchema(pool: Pool, schema: string = DEFAULT_SCHEMA): Promise<void> {
  await pool.query(schemaDdl(schema));
}
