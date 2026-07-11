-- A retained input must have one execution owner across rolling/multi-Host
-- deployments. The monotonic generation fences delayed async work even when
-- the same Host later reclaims an expired/released row.

ALTER TABLE oma.pending_events
  ADD COLUMN IF NOT EXISTS claim_owner TEXT;

ALTER TABLE oma.pending_events
  ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ;

ALTER TABLE oma.pending_events
  ADD COLUMN IF NOT EXISTS claim_generation BIGINT NOT NULL DEFAULT 0;
