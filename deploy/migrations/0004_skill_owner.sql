-- #72 (ADR-0004): Equipping a Skill forks it into an Agent-owned copy.
-- The skills table gains an owner so a Library Skill and an Agent's fork are
-- distinct rows: owner_type (library | agent), owner_id (tenantId for a Library
-- Skill, agentId for a fork), and source_skill_id (the Library Skill a fork was
-- snapshotted from; NULL for Library Skills).
--
-- Prod runs PG_ENSURE_SCHEMA=false and oma_app lacks CREATE, so this is applied
-- out-of-band (e.g. Supabase MCP) by the orchestrator. Idempotent — mirrors the
-- DDL in server/packages/store/src/postgres/schema.ts.
ALTER TABLE oma.skills ADD COLUMN IF NOT EXISTS owner_type      TEXT NOT NULL DEFAULT 'library';
ALTER TABLE oma.skills ADD COLUMN IF NOT EXISTS owner_id        TEXT NOT NULL DEFAULT '';
ALTER TABLE oma.skills ADD COLUMN IF NOT EXISTS source_skill_id TEXT;

-- Backfill: existing rows predate the split and are all Library Skills owned by
-- their tenant. Set owner_id = tenant_id for the library rows still at the ''
-- default (safe to re-run: the WHERE excludes already-migrated rows).
UPDATE oma.skills SET owner_id = tenant_id WHERE owner_type = 'library' AND owner_id = '';

CREATE INDEX IF NOT EXISTS skills_owner_idx ON oma.skills (tenant_id, owner_type, owner_id);
