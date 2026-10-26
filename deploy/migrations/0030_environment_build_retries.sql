-- Environment Builds count retries apart from attempts (ADR-0024, "Building"):
-- an attempt is every claim and every retry (it fences the lease and names the
-- attempt's pod); a retry is an infrastructure failure retried, twice at most.
-- A builder that stops or restarts starts an attempt but uses no retry.
-- Mirrors the idempotent ensureSchema DDL.
--
-- Additive: the previous image neither reads nor writes the column, so apply
-- it before starting the image that needs it. Existing builds start at 0.
-- Rollback: start the previous image, then 0030_environment_build_retries.rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE oma.environment_builds ADD COLUMN retries integer NOT NULL DEFAULT 0;
COMMIT;
