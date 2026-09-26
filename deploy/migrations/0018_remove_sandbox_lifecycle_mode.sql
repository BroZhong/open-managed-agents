-- Lifecycle management is unconditional for every durable Sandbox binding.
-- Apply after deploying a Runner that no longer reads lifecycle_managed.
BEGIN;
CREATE OR REPLACE FUNCTION oma.invalidate_sandbox_idle() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE binding TEXT;
BEGIN
  SELECT COALESCE(delegation->>'sandboxSessionId', id) INTO binding
    FROM oma.sessions WHERE id = NEW.session_id;
  UPDATE oma.delegation_environments SET idle_since = NULL
    WHERE id = binding;
  RETURN NEW;
END;
$$;
ALTER TABLE oma.delegation_environments DROP COLUMN IF EXISTS lifecycle_managed;
COMMIT;
