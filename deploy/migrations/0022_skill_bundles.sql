-- Record each Skill's current Skill Bundle (ADR-0022): the sha256 of its
-- immutable zip under __oma/skills/ in the Workspace OSS Bucket, and its total
-- uncompressed size. The two are set together; NULL until the bundle migration
-- packs the Skill's existing files. Mirrors the idempotent ensureSchema DDL.
--
-- Additive and nullable. Prod runs PG_ENSURE_SCHEMA=false: apply this migration
-- before deploying the store that reads and writes these columns. Adding a
-- nullable column without a default only rewrites the catalog; lock_timeout
-- bounds the wait for the brief exclusive lock behind a long transaction.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE oma.skills ADD COLUMN IF NOT EXISTS bundle_sha256 TEXT;
ALTER TABLE oma.skills ADD COLUMN IF NOT EXISTS bundle_size BIGINT;
COMMIT;
