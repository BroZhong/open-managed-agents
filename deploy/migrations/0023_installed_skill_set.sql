-- Record what each environment binding's Sandbox holds (ADR-0022): the Sandbox
-- the last complete Skill Install went into and the Skill Set hash it
-- installed. A Turn whose Sandbox and Skill Set both match skips the install.
-- Both NULL until an install is recorded. Mirrors the idempotent ensureSchema DDL.
--
-- Additive and nullable. Prod runs PG_ENSURE_SCHEMA=false: apply this migration
-- before deploying the Runner that reads and writes these columns. Adding a
-- nullable column without a default only rewrites the catalog; lock_timeout
-- bounds the wait for the brief exclusive lock behind a long transaction.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE oma.delegation_environments ADD COLUMN IF NOT EXISTS skills_sandbox_id TEXT;
ALTER TABLE oma.delegation_environments ADD COLUMN IF NOT EXISTS skills_set_hash TEXT;
COMMIT;
