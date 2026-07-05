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

-- Skills are a tenant-scoped Library of reusable, instruction-only capabilities
-- (a directory with a SKILL.md). Metadata lives here; file bodies live in S3
-- under <tenantId>/skills/<skillId>/… (isolated from Workspace prefixes).
-- Equipping a Skill onto an Agent is by reference (Agent.skills holds skillIds);
-- there is no join table.
CREATE TABLE IF NOT EXISTS ${s}.skills (
  skill_id     TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, skill_id)
);
CREATE INDEX IF NOT EXISTS skills_tenant_id_idx ON ${s}.skills (tenant_id, skill_id);

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
  created_at     TIMESTAMPTZ NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL,
  terminated_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS sessions_tenant_id_idx ON ${s}.sessions (tenant_id, id);
CREATE INDEX IF NOT EXISTS sessions_agent_id_idx ON ${s}.sessions (agent_id);
CREATE INDEX IF NOT EXISTS sessions_workspace_id_idx ON ${s}.sessions (tenant_id, workspace_id);

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
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS ${s}.pending_events (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL,
  type               TEXT NOT NULL,
  data               JSONB,
  session_thread_id  TEXT NOT NULL,
  arrived_at         TIMESTAMPTZ NOT NULL,
  seq                BIGSERIAL
);
CREATE INDEX IF NOT EXISTS pending_events_session_idx ON ${s}.pending_events (session_id, seq);

CREATE TABLE IF NOT EXISTS ${s}.api_keys (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  key_hash    TEXT NOT NULL UNIQUE,
  prefix      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL
);
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
