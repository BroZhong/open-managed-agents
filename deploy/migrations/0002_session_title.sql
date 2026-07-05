-- #57: Session title — a truncated snapshot of the user's first message,
-- written on first send. Optional; historical sessions have none (NULL).
--
-- Prod runs PG_ENSURE_SCHEMA=false and oma_app lacks CREATE, so this is applied
-- out-of-band (e.g. Supabase MCP) by the orchestrator. Idempotent.
ALTER TABLE oma.sessions ADD COLUMN IF NOT EXISTS title TEXT;
