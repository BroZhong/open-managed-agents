-- At-least-once pending-input promotion needs a stable identity on the
-- canonical Event. A retry after an ambiguous commit returns the already
-- inserted row instead of allocating a duplicate user.message sequence.
--
-- Prod runs PG_ENSURE_SCHEMA=false, so apply this migration before deploying
-- the server version that writes events.idempotency_key.

ALTER TABLE oma.events
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS events_session_idempotency_key_uidx
  ON oma.events (session_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
