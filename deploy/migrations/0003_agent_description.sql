-- Agent description — an optional human-readable blurb shown in the console to
-- help people tell Agents apart. Purely informational: it is NOT injected into
-- the model context / prompt. Optional; existing Agents have none (NULL).
--
-- Prod runs PG_ENSURE_SCHEMA=false and oma_app lacks CREATE, so this is applied
-- out-of-band (e.g. Supabase MCP) by the orchestrator. Idempotent.
ALTER TABLE oma.agents ADD COLUMN IF NOT EXISTS description TEXT;
