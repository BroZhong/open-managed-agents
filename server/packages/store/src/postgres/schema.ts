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

CREATE TABLE IF NOT EXISTS ${s}.agents (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  model        TEXT NOT NULL,
  system       TEXT NOT NULL,
  runtime      TEXT NOT NULL,
  tools        JSONB,
  mcp_servers  JSONB,
  skills       JSONB,
  sandbox      JSONB,
  created_at   TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL
);
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
  updated_at      TIMESTAMPTZ NOT NULL,
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

-- Workspaces are tenant-owned; the S3-authoritative home of a Session's
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
ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS loop_id TEXT;
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
ALTER TABLE ${s}.pending_events ADD COLUMN IF NOT EXISTS api_key_id TEXT;
ALTER TABLE ${s}.pending_events ADD COLUMN IF NOT EXISTS claim_owner TEXT;
ALTER TABLE ${s}.pending_events ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ;
ALTER TABLE ${s}.pending_events ADD COLUMN IF NOT EXISTS claim_generation BIGINT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS pending_events_session_idx ON ${s}.pending_events (session_id, seq);

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
`;
}

/** Create the schema and all tables if they do not exist. */
export async function ensureSchema(pool: Pool, schema: string = DEFAULT_SCHEMA): Promise<void> {
  await pool.query(schemaDdl(schema));
}
