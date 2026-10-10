-- Apply with old Runners stopped; no mixed-policy operation or resource adoption.
-- This removes only OMA's reclamation state, never platform resources or files.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE oma.delegation_environments ADD COLUMN IF NOT EXISTS creation_pending BOOLEAN NOT NULL DEFAULT FALSE;
DROP TRIGGER IF EXISTS sandbox_input_activity ON oma.pending_events;
DROP FUNCTION IF EXISTS oma.invalidate_sandbox_idle();
DROP TABLE IF EXISTS oma.sandbox_activities;
ALTER TABLE oma.delegation_environments DROP COLUMN IF EXISTS idle_since;
CREATE OR REPLACE FUNCTION oma.lock_sandbox_binding() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE binding TEXT;
BEGIN
  SELECT COALESCE(delegation->>'sandboxSessionId', id) INTO binding FROM oma.sessions WHERE id=NEW.session_id;
  IF binding IS NOT NULL THEN
    INSERT INTO oma.delegation_environments (id, sandbox_id) VALUES (binding, NULL) ON CONFLICT DO NOTHING;
    PERFORM id FROM oma.delegation_environments WHERE id=binding FOR UPDATE;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS sandbox_input_coordination ON oma.pending_events;
CREATE TRIGGER sandbox_input_coordination BEFORE INSERT ON oma.pending_events
  FOR EACH ROW EXECUTE FUNCTION oma.lock_sandbox_binding();
REVOKE ALL ON FUNCTION oma.lock_sandbox_binding() FROM PUBLIC;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='oma_app') THEN
    GRANT EXECUTE ON FUNCTION oma.lock_sandbox_binding() TO oma_app;
  END IF;
END;
$migration$;
COMMIT;
