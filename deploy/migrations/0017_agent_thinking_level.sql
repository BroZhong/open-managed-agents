-- Persist the provider-neutral Pi thinking level configured for an Agent.
ALTER TABLE oma.agents ADD COLUMN IF NOT EXISTS thinking TEXT;

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oma_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE oma.agents TO oma_app;
  END IF;
END;
$migration$;
