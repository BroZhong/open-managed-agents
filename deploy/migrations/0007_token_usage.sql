-- Attribute durable model usage to the API key that accepted each Turn.
-- Browser session-token requests deliberately leave api_key_id NULL: their
-- usage remains visible per Session but is not charged to an API key.
-- API keys are soft-revoked so their durable usage remains listable.

ALTER TABLE oma.pending_events
  ADD COLUMN IF NOT EXISTS api_key_id TEXT;

ALTER TABLE oma.events
  ADD COLUMN IF NOT EXISTS api_key_id TEXT;

ALTER TABLE oma.api_keys
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS events_session_usage_idx
  ON oma.events (session_id, seq)
  WHERE type = 'span.model_request_end';

CREATE INDEX IF NOT EXISTS events_api_key_usage_idx
  ON oma.events (api_key_id, session_id, seq)
  WHERE type = 'span.model_request_end' AND api_key_id IS NOT NULL;
