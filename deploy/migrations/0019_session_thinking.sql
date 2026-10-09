-- NULL inherits the Agent preference; updates apply on the next Turn.
ALTER TABLE oma.sessions ADD COLUMN IF NOT EXISTS thinking TEXT;
