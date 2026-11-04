-- Delegation transactions lock their Delegation Family, a parent Session and
-- its Child Sessions, with a transaction-scoped advisory lock (ADR-0027)
-- instead of the one row of delegation_lock, which serialized every family's
-- transactions on every Runner. Advisory locks need no grant.
--
-- Contracting: the previous image locks this row in every delegation
-- transaction and fails without it, and the image that locks families does
-- not exclude it. Apply once every Runner runs the family-lock image (no
-- previous Runner left, e.g. after its rollout completed).
-- Rollback: 0031_drop_delegation_lock.rollback.sql, before starting the previous image.
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP TABLE IF EXISTS oma.delegation_lock;
COMMIT;
