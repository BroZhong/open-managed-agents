-- Rollback of 0031_drop_delegation_lock.sql: recreate the global coordination
-- row as 0012_durable_delegations.sql created it, with its grant (SELECT FOR
-- UPDATE needs UPDATE). Apply before starting the previous image, which locks
-- the row in every delegation transaction; the family-lock image ignores it.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS oma.delegation_lock (id TEXT PRIMARY KEY);
INSERT INTO oma.delegation_lock (id) VALUES ('coordination') ON CONFLICT DO NOTHING;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oma_app') THEN
    REVOKE ALL PRIVILEGES ON TABLE oma.delegation_lock FROM oma_app;
    GRANT SELECT, UPDATE ON TABLE oma.delegation_lock TO oma_app;
  END IF;
END;
$migration$;
COMMIT;
