-- A binding records when its creation intent was committed, by the database
-- clock, instead of a flag that only a successful create could clear
-- (ADR-0023). Past the intent deadline (180 s) any Runner reconciles the
-- binding with the gateway by its oma.dev/binding label: it adopts the Sandbox
-- found, or returns the binding to Cold.
--
-- Apply with the Runners scaled to 0: no create is in flight and no old code
-- writes creation_pending. A pending row is therefore past its deadline, and
-- the epoch makes the first use (or sweep) reconcile it. There is no
-- compatibility branch; the new image starts after this migration.
-- Rollback: 0024_binding_creating_since.rollback.sql, then the previous image.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE oma.delegation_environments ADD COLUMN creating_since timestamptz;
UPDATE oma.delegation_environments SET creating_since = 'epoch' WHERE creation_pending;
ALTER TABLE oma.delegation_environments DROP COLUMN creation_pending;
COMMIT;
