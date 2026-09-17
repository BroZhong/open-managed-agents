-- Additive migration. Share IDs are capabilities, not Session IDs or snapshots.
CREATE TABLE IF NOT EXISTS oma.session_shares (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE
);

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oma_app') THEN
    REVOKE ALL PRIVILEGES ON TABLE oma.session_shares FROM oma_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE oma.session_shares TO oma_app;
  END IF;
END;
$migration$;
