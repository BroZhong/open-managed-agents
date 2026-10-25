-- Rollback of 0024_binding_creating_since.sql (ADR-0023, "Migration and
-- rollout"): restore creation_pending for the previous image. Every binding
-- with a creation intent, expired or not, becomes pending again, which that
-- image treats as unconfirmed until an operator clears it. Apply with the
-- Runners scaled to 0, then start the previous image.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE oma.delegation_environments ADD COLUMN creation_pending BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE oma.delegation_environments SET creation_pending = TRUE WHERE creating_since IS NOT NULL;
ALTER TABLE oma.delegation_environments DROP COLUMN creating_since;
COMMIT;
