-- #55: Workspace as a first-class, nameable entity.
-- Adds an optional human-friendly name to workspaces.
--
-- Prod runs PG_ENSURE_SCHEMA=false and oma_app lacks CREATE, so this is applied
-- out-of-band (e.g. Supabase MCP) by the orchestrator. Idempotent.
ALTER TABLE oma.workspaces ADD COLUMN IF NOT EXISTS name TEXT;
