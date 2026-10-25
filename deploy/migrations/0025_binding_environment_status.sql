-- What GET /v1/sessions/{id} reports of a Session's environment (ADR-0023,
-- "The Router acquires and releases; failures are tool errors"), kept on its
-- binding: state_since is when the reported state began, by the database
-- clock (the binding's last move, its first environment failure since, or its
-- recovery from one); last_error_* is the last environment failure a
-- preparation observed in that state, with its code, reason and time. A move
-- or a preparation that ends ready clears it.
--
-- Additive: the previous image neither reads nor writes these columns, so
-- apply it before starting the image that needs them. Rows Creating at the
-- migration get their intent's start as state_since; other rows get it on
-- their next move.
-- Rollback: start the previous image, then 0025_binding_environment_status.rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE oma.delegation_environments
  ADD COLUMN state_since timestamptz,
  ADD COLUMN last_error_code text,
  ADD COLUMN last_error_reason text,
  ADD COLUMN last_error_at timestamptz;
UPDATE oma.delegation_environments SET state_since = creating_since WHERE creating_since IS NOT NULL;
COMMIT;
