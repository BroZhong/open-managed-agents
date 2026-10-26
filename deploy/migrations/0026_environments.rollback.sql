-- Rollback of 0026_environments.sql: drop Environments and their builds.
-- Every Environment and build record is lost; images already pushed stay in
-- the registry. Apply once the previous image runs; the image that serves
-- /v1/environments fails without these tables.
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP TABLE oma.environment_builds;
DROP TABLE oma.environments;
COMMIT;
