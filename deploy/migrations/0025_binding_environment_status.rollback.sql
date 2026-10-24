-- Rollback of 0025_binding_environment_status.sql: drop what the Session API
-- reads of a binding's environment. Apply once the previous image runs; the
-- image that writes these columns fails without them.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE oma.delegation_environments
  DROP COLUMN state_since,
  DROP COLUMN last_error_code,
  DROP COLUMN last_error_reason,
  DROP COLUMN last_error_at;
COMMIT;
