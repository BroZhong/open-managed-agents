-- Additive migration; apply before either role or the compatible combined Host.
BEGIN;
CREATE TABLE IF NOT EXISTS oma.session_cleanup (
  session_id TEXT PRIMARY KEY,
  retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS session_cleanup_retry_idx ON oma.session_cleanup (retry_at) WHERE completed_at IS NULL;
-- Old terminated Sessions remain discoverable without relying on old callbacks.
INSERT INTO oma.session_cleanup (session_id)
SELECT id FROM oma.sessions WHERE status = 'terminated'
ON CONFLICT DO NOTHING;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oma_app') THEN
    GRANT SELECT, INSERT, UPDATE ON oma.session_cleanup TO oma_app;
  END IF;
END $$;
COMMIT;
