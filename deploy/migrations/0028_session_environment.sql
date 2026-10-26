-- Sessions run in Environments (ADR-0024, "Starting a Sandbox"): an Agent
-- references the Environment its new Sessions run in, a Session freezes its
-- Environment at creation, and a Sandbox Binding records the Environment and
-- image its Sandbox was created with (set with sandbox_id, NULL with it).
-- NULL means no Environment (until 0029 binds every Sandboxed Agent and
-- Session to one). Mirrors the idempotent ensureSchema DDL.
--
-- Additive: the previous image neither reads nor writes these columns, so
-- apply it before starting the image that needs them. Existing rows keep NULL
-- (Agents and Sessions are bound to Environments by a later migration).
-- Rollback: start the previous image, then 0028_session_environment.rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE oma.agents ADD COLUMN environment_id text;
ALTER TABLE oma.sessions ADD COLUMN environment_id text;
ALTER TABLE oma.delegation_environments
  ADD COLUMN environment_id text,
  ADD COLUMN image text;
COMMIT;
