-- Apply before deploying API/CLI support for Idempotency-Key.
-- Keys have no automatic expiry; soft deletion/termination does not release them.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS oma.session_creation_keys (
  tenant_id TEXT NOT NULL,
  key TEXT NOT NULL,
  request TEXT NOT NULL,
  session_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key)
);
-- The runtime only reserves and reads keys; it never updates or deletes them.
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oma_app') THEN
    REVOKE ALL PRIVILEGES ON TABLE oma.session_creation_keys FROM oma_app;
    GRANT SELECT, INSERT ON TABLE oma.session_creation_keys TO oma_app;
  END IF;
END;
$migration$;
COMMIT;
