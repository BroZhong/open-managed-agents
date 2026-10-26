-- Rollback of 0028_session_environment.sql: drop which Environment Agents,
-- Sessions and Sandbox Bindings reference. Every Agent's binding, every
-- Session's frozen Environment and every binding's recorded image are lost.
-- Apply once the previous image runs; the image that writes these columns
-- fails without them.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE oma.agents DROP COLUMN environment_id;
ALTER TABLE oma.sessions DROP COLUMN environment_id;
ALTER TABLE oma.delegation_environments
  DROP COLUMN environment_id,
  DROP COLUMN image;
COMMIT;
