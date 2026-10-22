-- Indexes for the delegation lookups made on every tool result, every Child
-- heartbeat and every pending scan of every Runner; the tables are never pruned.
-- Additive: apply before or after the Runner image. Plain CREATE INDEX rather
-- than CONCURRENTLY: migrations run in one transaction (here, and atomically
-- through the test schema's RPC path), and these tables hold a few hundred rows,
-- so the write lock lasts milliseconds. lock_timeout bounds the wait behind a
-- long delegation transaction.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE INDEX IF NOT EXISTS delegation_waits_input_idx ON oma.delegation_waits ((record->>'callerSessionId'), (record->>'parentPendingEventId'));
CREATE INDEX IF NOT EXISTS delegation_waits_waiting_idx ON oma.delegation_waits (id) WHERE record->>'status' = 'waiting';
CREATE INDEX IF NOT EXISTS delegation_commands_execution_idx ON oma.delegation_commands ((record->>'executionId'));
CREATE INDEX IF NOT EXISTS delegation_executions_open_idx ON oma.delegation_executions (id) WHERE record->>'status' IN ('queued', 'running');
COMMIT;
