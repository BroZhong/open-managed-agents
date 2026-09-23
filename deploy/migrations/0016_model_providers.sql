-- Tenant provider credentials inside config are AES-256-GCM ciphertext.
CREATE TABLE IF NOT EXISTS oma.model_providers (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  config JSONB NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oma_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE oma.model_providers TO oma_app;
  END IF;
END;
$migration$;
