-- Environments and Environment Builds (ADR-0024, "The resource" and
-- "Building"). An Environment is a Base Image, an init script and variables,
-- built once into an image; Built-in Environments are rows with owner_type
-- 'platform', no tenant and a fixed id. The API writes an environment_builds
-- row in the transaction that creates an Environment or changes its Base Image
-- or init script, superseding the active one (ADR-0018); the image builder
-- claims rows by lease. Mirrors the idempotent ensureSchema DDL.
--
-- Additive: the previous image neither reads nor writes these tables, so apply
-- it before starting the image that serves /v1/environments.
-- Rollback: start the previous image, then 0026_environments.rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS oma.environments (
  id             TEXT PRIMARY KEY,
  owner_type     TEXT NOT NULL CHECK (owner_type IN ('platform', 'tenant')),
  tenant_id      TEXT,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL,
  base_image     TEXT NOT NULL,
  init_script    TEXT NOT NULL,
  env            JSONB NOT NULL,
  secrets        JSONB NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('pending', 'building', 'failed', 'ready')),
  image          TEXT,
  manifest       JSONB,
  last_build_id  TEXT,
  created_at     TIMESTAMPTZ NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL,
  deleted_at     TIMESTAMPTZ,
  CHECK ((owner_type = 'platform') = (tenant_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS environments_tenant_name_unique
  ON oma.environments (tenant_id, name) WHERE owner_type = 'tenant' AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS environments_platform_name_unique
  ON oma.environments (owner_type, name) WHERE owner_type = 'platform' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS oma.environment_builds (
  id                 TEXT PRIMARY KEY,
  seq                BIGSERIAL,
  environment_id     TEXT NOT NULL,
  owner_type         TEXT NOT NULL,
  tenant_id          TEXT,
  status             TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'superseded')),
  base_image         TEXT NOT NULL,
  init_script        TEXT NOT NULL,
  definition_sha256  TEXT NOT NULL,
  base_image_digest  TEXT,
  attempts           INTEGER NOT NULL DEFAULT 0,
  lease_owner        TEXT,
  lease_expires_at   TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL,
  started_at         TIMESTAMPTZ,
  finished_at        TIMESTAMPTZ,
  error_code         TEXT,
  error_message      TEXT,
  image              TEXT,
  manifest           JSONB,
  log_key            TEXT
);
CREATE INDEX IF NOT EXISTS environment_builds_environment_idx
  ON oma.environment_builds (environment_id);
CREATE UNIQUE INDEX IF NOT EXISTS environment_builds_active_unique
  ON oma.environment_builds (environment_id) WHERE status IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS environment_builds_claim_idx
  ON oma.environment_builds (seq) WHERE status IN ('pending', 'running');

-- The Host never deletes either row: Environments are soft-deleted and
-- builds are history.
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oma_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE oma.environments, oma.environment_builds TO oma_app;
    GRANT USAGE ON SEQUENCE oma.environment_builds_seq_seq TO oma_app;
  END IF;
END;
$migration$;
COMMIT;
