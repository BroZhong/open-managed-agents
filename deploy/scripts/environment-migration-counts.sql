-- Read-only counts for migration 0029 (ADR-0024, "Migration"): run before it
-- to see what it will change, and after it to record what it did. Rewrite for
-- an environment as the migrations are:
--   node deploy/scripts/migration-for-env.mjs test deploy/scripts/environment-migration-counts.sql | psql ...
-- Prints names, never values.
SELECT 'video-production ready' AS check, count(*) AS n FROM oma.environments
WHERE id = 'env_video_production' AND deleted_at IS NULL AND image IS NOT NULL
UNION ALL SELECT 'Sandboxed Agents', count(*) FROM oma.agents
WHERE sandbox IS NULL OR sandbox->>'enabled' IS DISTINCT FROM 'false'
UNION ALL SELECT 'Sandboxed Agents without an Environment (to bind)', count(*) FROM oma.agents
WHERE environment_id IS NULL AND (sandbox IS NULL OR sandbox->>'enabled' IS DISTINCT FROM 'false')
UNION ALL SELECT 'of them with sandbox.env (a copy each, unless every name is dropped)', count(*) FROM oma.agents
WHERE environment_id IS NULL AND (sandbox IS NULL OR sandbox->>'enabled' IS DISTINCT FROM 'false')
  AND jsonb_typeof(sandbox->'env') = 'object' AND sandbox->'env' <> '{}'::jsonb
UNION ALL SELECT 'Agents with sandbox.image or sandbox.env (to strip)', count(*) FROM oma.agents
WHERE sandbox ?| ARRAY['image', 'env']
UNION ALL SELECT 'Sessions without an Environment', count(*) FROM oma.sessions WHERE environment_id IS NULL
UNION ALL SELECT 'Session snapshots with sandbox.image or sandbox.env (to strip)', count(*) FROM oma.sessions
WHERE agent->'sandbox' ?| ARRAY['image', 'env']
UNION ALL SELECT 'Tenant copies made by 0029', count(*) FROM oma.environments WHERE id LIKE 'env_agent_%';

-- Agents bound per Environment, Sessions frozen per Environment.
SELECT 'agents' AS kind, COALESCE(environment_id, '(none)') AS environment_id, count(*) AS n FROM oma.agents GROUP BY 2
UNION ALL SELECT 'sessions', COALESCE(environment_id, '(none)'), count(*) FROM oma.sessions GROUP BY 2
ORDER BY 1, 2;

-- The variable names each Agent's copy would drop: empty values and names the platform reserves.
SELECT a.id AS agent_id, v.key AS dropped_name, CASE WHEN v.value = '' THEN 'empty' ELSE 'reserved' END AS why
FROM oma.agents a CROSS JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(a.sandbox->'env') = 'object' THEN a.sandbox->'env' ELSE '{}'::jsonb END) v
WHERE a.environment_id IS NULL AND a.sandbox->>'enabled' IS DISTINCT FROM 'false'
  AND (v.value = '' OR v.key !~ '^[A-Za-z_][A-Za-z0-9_]*$' OR v.key ~ '^(OMA_|E2B_|ENVD_|BASH_)'
    OR v.key IN ('HOME', 'WORKSPACE_DIR', 'STORY_SEED_WORKSPACE', 'MEDIAKIT_OUTPUT_PATH', 'XDG_CACHE_HOME',
      'NPM_CONFIG_CACHE', 'NPM_CONFIG_PREFIX', 'NODE_PATH', 'PIP_CACHE_DIR', 'PYTHONPATH', 'TMPDIR',
      'PATH', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'OLDPWD', 'SHLVL', 'HOSTNAME', 'UID', 'EUID', 'PPID', 'IFS',
      'ENV', 'BASH_ENV', 'PS4', 'PROMPT_COMMAND', 'SHELLOPTS', 'BASHOPTS', 'BASHPID', 'LD_PRELOAD'))
ORDER BY 1, 2;
