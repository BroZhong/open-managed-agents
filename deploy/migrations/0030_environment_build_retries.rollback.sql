-- Rollback of 0030_environment_build_retries.sql: drop the retry count. A
-- build running then may be retried more often than twice. Apply once the
-- previous image runs; the image that writes the column fails without it.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE oma.environment_builds DROP COLUMN retries;
COMMIT;
