-- The production oma schema has default table privileges that grant oma_app
-- more than a newly created Loop table needs. Reset the inherited ACL before
-- granting the exact capabilities used by LoopStore. Keep this separate from
-- 0007 so already-migrated databases are hardened as well as fresh installs.

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oma_app')
     AND to_regclass('oma.loops') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE oma.loops FROM oma_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE oma.loops TO oma_app';
  END IF;
END;
$migration$;
