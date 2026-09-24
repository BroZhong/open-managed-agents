-- Lifecycle management is unconditional for every durable Sandbox binding.
-- Apply after deploying a Runner that no longer reads lifecycle_managed.
BEGIN;
ALTER TABLE oma.delegation_environments DROP COLUMN IF EXISTS lifecycle_managed;
COMMIT;
