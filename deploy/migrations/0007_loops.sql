-- Loops schedule recurring Agent Sessions. A due dispatch atomically creates a
-- fresh Workspace, its Loop-linked Session, and the first pending user.message
-- before advancing next_run_at. The API requires intervals of at least five
-- minutes; the database stores the interval as an integer number of minutes.
--
-- Prod runs PG_ENSURE_SCHEMA=false and oma_app lacks CREATE, so apply this
-- migration before deploying the server version that starts LoopScheduler.

CREATE TABLE IF NOT EXISTS oma.loops (
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

CREATE INDEX IF NOT EXISTS loops_tenant_agent_idx
  ON oma.loops (tenant_id, agent_id, created_at);

CREATE INDEX IF NOT EXISTS loops_due_idx
  ON oma.loops (next_run_at)
  WHERE enabled = true;

ALTER TABLE oma.sessions
  ADD COLUMN IF NOT EXISTS loop_id TEXT;

CREATE INDEX IF NOT EXISTS sessions_loop_id_idx
  ON oma.sessions (tenant_id, loop_id, created_at DESC);

-- Production runs the Host as oma_app. Grant only the capabilities LoopStore
-- uses on the new table; the role already has its existing Session, Workspace,
-- and pending-event privileges. The role guard keeps this migration portable
-- to development/test databases where oma_app is intentionally absent.
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oma_app') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA oma TO oma_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE oma.loops TO oma_app';
  END IF;
END;
$migration$;
