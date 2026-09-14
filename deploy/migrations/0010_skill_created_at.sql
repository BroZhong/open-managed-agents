-- Record Library Skill upload time and Agent Skill fork creation time.
-- Prod runs PG_ENSURE_SCHEMA=false: apply this migration before deploying the
-- store that writes created_at. Mirrors the idempotent ensureSchema DDL.
--
-- Existing rows stay NULL: updated_at may reflect an edit and cannot recover
-- the actual upload time. New uploads/forks explicitly set both timestamps.
ALTER TABLE oma.skills ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
