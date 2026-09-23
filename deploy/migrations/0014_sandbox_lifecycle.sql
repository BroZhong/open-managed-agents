-- Apply before deploying the Host (production uses PG_ENSURE_SCHEMA=false).
-- Does not adopt, renew or delete resources; the trigger touches managed rows only.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE oma.delegation_environments ADD COLUMN IF NOT EXISTS lifecycle_managed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE oma.delegation_environments ADD COLUMN IF NOT EXISTS idle_since TIMESTAMPTZ;
ALTER TABLE oma.delegation_environments ADD COLUMN IF NOT EXISTS reclaiming BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS oma.sandbox_activities (
  id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  pending_event_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  generation BIGINT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sandbox_activities_binding_idx ON oma.sandbox_activities(binding_id);
CREATE INDEX IF NOT EXISTS sessions_sandbox_binding_idx ON oma.sessions ((COALESCE(delegation->>'sandboxSessionId', id)));
-- All ingress paths, including transactional delegation results and batch user
-- input, invalidate idle time under the same row lock used to claim deletion.
CREATE OR REPLACE FUNCTION oma.invalidate_sandbox_idle() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE binding TEXT;
BEGIN
  SELECT COALESCE(delegation->>'sandboxSessionId', id) INTO binding
    FROM oma.sessions WHERE id = NEW.session_id;
  UPDATE oma.delegation_environments SET idle_since = NULL
    WHERE id = binding AND lifecycle_managed = TRUE;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS sandbox_input_activity ON oma.pending_events;
CREATE TRIGGER sandbox_input_activity BEFORE INSERT ON oma.pending_events
  FOR EACH ROW EXECUTE FUNCTION oma.invalidate_sandbox_idle();
REVOKE ALL ON FUNCTION oma.invalidate_sandbox_idle() FROM PUBLIC;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oma_app') THEN
    REVOKE ALL PRIVILEGES ON TABLE oma.sandbox_activities FROM oma_app;
    GRANT SELECT, INSERT, DELETE ON TABLE oma.sandbox_activities TO oma_app;
    GRANT EXECUTE ON FUNCTION oma.invalidate_sandbox_idle() TO oma_app;
  END IF;
END;
$migration$;
COMMIT;
