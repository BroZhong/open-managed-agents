-- Agents and Sessions move onto Environments (ADR-0024, "Migration"). Every
-- Sandboxed Agent without an Environment is bound to the built-in
-- video-production (env_video_production). One that set sandbox.env gets a
-- Tenant copy of video-production instead, with those variables, and is bound
-- to it. Every Sandboxed Session without an Environment is frozen to its
-- Agent's (video-production for a deleted Agent). Then sandbox.image and
-- sandbox.env leave every stored Agent and Session snapshot; sandbox.enabled
-- stays.
--
-- Requires the built-in with a serving image: oma-image-builder upserts and
-- builds it from sandbox/environments/video-production/ at startup, so run
-- this after the builder reported it ready. Without it the migration fails
-- and changes nothing.
--
-- A copy keeps the Agent's variables as plain values. They were stored, and
-- returned by GET /v1/agents, in plaintext; as plain Environment variables
-- they stay visible to the same Tenant, leave the Sandbox CR, and can be made
-- secrets in the console. A variable of the same name as one of
-- video-production's replaces it (an Agent's sandbox.env won over the
-- deployment's); empty values and names the platform reserves are dropped
-- (environment-migration-counts.sql lists them first). A copy has the
-- built-in's Base Image and init script and a pending build, which the image
-- builder runs; until then it serves video-production's image, which that
-- same definition built, so the Agent's Sessions keep running.
--
-- What it changes is kept in migration_0029_agents / migration_0029_sessions
-- for the rollback; drop them once the release is accepted.
-- Rollback: start the previous image, then 0029_environment_migration.rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM oma.environments e JOIN oma.environment_builds b ON b.id = e.last_build_id
    WHERE e.id = 'env_video_production' AND e.owner_type = 'platform' AND e.deleted_at IS NULL AND e.image IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'migration 0029: the built-in Environment env_video_production does not exist or serves no image yet; start oma-image-builder and wait until it is ready';
  END IF;
END;
$migration$;

-- Sandboxed: sandbox.enabled is not false, as isSandboxedAgent reads it.
CREATE TABLE IF NOT EXISTS oma.migration_0029_agents (
  agent_id               TEXT PRIMARY KEY,
  sandbox                JSONB,
  environment_id         TEXT,
  copied_environment_id  TEXT
);
CREATE TABLE IF NOT EXISTS oma.migration_0029_sessions (
  session_id      TEXT PRIMARY KEY,
  agent_sandbox   JSONB,
  environment_id  TEXT
);

INSERT INTO oma.migration_0029_agents (agent_id, sandbox, environment_id)
SELECT id, sandbox, environment_id FROM oma.agents
WHERE (environment_id IS NULL AND (sandbox IS NULL OR sandbox->>'enabled' IS DISTINCT FROM 'false'))
   OR sandbox ?| ARRAY['image', 'env']
ON CONFLICT (agent_id) DO NOTHING;

-- The variables each copy takes from its Agent. The reserved names are
-- isReservedEnvironmentVariable's as of this release.
CREATE TEMP TABLE migration_0029_vars ON COMMIT DROP AS
SELECT a.id AS agent_id, v.key AS name, v.value
FROM oma.agents a
CROSS JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(a.sandbox->'env') = 'object' THEN a.sandbox->'env' ELSE '{}'::jsonb END) v
WHERE a.environment_id IS NULL AND a.sandbox->>'enabled' IS DISTINCT FROM 'false'
  AND v.value <> ''
  AND v.key ~ '^[A-Za-z_][A-Za-z0-9_]*$'
  AND v.key !~ '^(OMA_|E2B_|ENVD_|BASH_)'
  AND v.key NOT IN ('HOME', 'WORKSPACE_DIR', 'STORY_SEED_WORKSPACE', 'MEDIAKIT_OUTPUT_PATH', 'XDG_CACHE_HOME',
    'NPM_CONFIG_CACHE', 'NPM_CONFIG_PREFIX', 'NODE_PATH', 'PIP_CACHE_DIR', 'PYTHONPATH', 'TMPDIR',
    'PATH', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'OLDPWD', 'SHLVL', 'HOSTNAME', 'UID', 'EUID', 'PPID', 'IFS',
    'ENV', 'BASH_ENV', 'PS4', 'PROMPT_COMMAND', 'SHELLOPTS', 'BASHOPTS', 'BASHPID', 'LD_PRELOAD');

CREATE TEMP TABLE migration_0029_copies ON COMMIT DROP AS
SELECT a.id AS agent_id, a.tenant_id, a.name AS agent_name, 'env_' || a.id AS environment_id, 'envb_' || a.id AS build_id
FROM oma.agents a WHERE EXISTS (SELECT 1 FROM migration_0029_vars v WHERE v.agent_id = a.id);

INSERT INTO oma.environment_builds (id, environment_id, owner_type, tenant_id, status, base_image, init_script, definition_sha256, created_at)
SELECT c.build_id, c.environment_id, 'tenant', c.tenant_id, 'pending', vp.base_image, vp.init_script, b.definition_sha256, now()
FROM migration_0029_copies c
CROSS JOIN oma.environments vp
JOIN oma.environment_builds b ON b.id = vp.last_build_id
WHERE vp.id = 'env_video_production';

-- video-production's variables in order, each replaced by the Agent's of the
-- same name, then the Agent's others by name.
INSERT INTO oma.environments (id, owner_type, tenant_id, name, description, base_image, init_script, env, secrets,
  status, image, manifest, last_build_id, created_at, updated_at)
SELECT c.environment_id, 'tenant', c.tenant_id, 'video-production-' || c.agent_id,
  'video-production with the sandbox.env of Agent ' || c.agent_name || ' (migration 0029)',
  vp.base_image, vp.init_script,
  (SELECT COALESCE(jsonb_agg(entry.value ORDER BY entry.position), '[]'::jsonb) FROM (
     SELECT CASE WHEN v.name IS NULL THEN e.value ELSE jsonb_build_object('name', v.name, 'value', v.value) END AS value,
       e.position AS position
     FROM jsonb_array_elements(vp.env) WITH ORDINALITY AS e(value, position)
     LEFT JOIN migration_0029_vars v ON v.agent_id = c.agent_id AND v.name = e.value->>'name'
     UNION ALL
     SELECT jsonb_build_object('name', v.name, 'value', v.value), 1000000 + row_number() OVER (ORDER BY v.name)
     FROM migration_0029_vars v
     WHERE v.agent_id = c.agent_id
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(vp.env) AS x(value) WHERE x.value->>'name' = v.name)
   ) entry),
  vp.secrets, 'pending', vp.image, vp.manifest, c.build_id, now(), now()
FROM migration_0029_copies c CROSS JOIN oma.environments vp
WHERE vp.id = 'env_video_production';

UPDATE oma.migration_0029_agents m SET copied_environment_id = c.environment_id
FROM migration_0029_copies c WHERE c.agent_id = m.agent_id;

UPDATE oma.agents a SET environment_id = c.environment_id
FROM migration_0029_copies c WHERE c.agent_id = a.id;
UPDATE oma.agents SET environment_id = 'env_video_production'
WHERE environment_id IS NULL AND (sandbox IS NULL OR sandbox->>'enabled' IS DISTINCT FROM 'false');

-- A Session is Sandboxed as its Agent is now; a deleted Agent's as its snapshot was.
INSERT INTO oma.migration_0029_sessions (session_id, agent_sandbox, environment_id)
SELECT s.id, s.agent->'sandbox', s.environment_id FROM oma.sessions s
LEFT JOIN oma.agents a ON a.id = s.agent_id
WHERE (s.environment_id IS NULL AND CASE WHEN a.id IS NULL THEN s.agent->'sandbox'->>'enabled' IS DISTINCT FROM 'false'
         ELSE a.environment_id IS NOT NULL AND (a.sandbox IS NULL OR a.sandbox->>'enabled' IS DISTINCT FROM 'false') END)
   OR s.agent->'sandbox' ?| ARRAY['image', 'env']
ON CONFLICT (session_id) DO NOTHING;

UPDATE oma.sessions s SET environment_id = COALESCE(
    (SELECT a.environment_id FROM oma.agents a WHERE a.id = s.agent_id), 'env_video_production')
WHERE s.environment_id IS NULL AND CASE
  WHEN EXISTS (SELECT 1 FROM oma.agents a WHERE a.id = s.agent_id)
    THEN EXISTS (SELECT 1 FROM oma.agents a WHERE a.id = s.agent_id AND a.environment_id IS NOT NULL
      AND (a.sandbox IS NULL OR a.sandbox->>'enabled' IS DISTINCT FROM 'false'))
  ELSE s.agent->'sandbox'->>'enabled' IS DISTINCT FROM 'false' END;

UPDATE oma.sessions SET agent = jsonb_set(agent, '{sandbox}', (agent->'sandbox') - 'image' - 'env')
WHERE agent->'sandbox' ?| ARRAY['image', 'env'];
UPDATE oma.agents SET sandbox = sandbox - 'image' - 'env'
WHERE sandbox ?| ARRAY['image', 'env'];
COMMIT;
