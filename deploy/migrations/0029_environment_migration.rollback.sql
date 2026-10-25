-- Rollback of 0029_environment_migration.sql, from what it kept: every Agent
-- and Session snapshot gets its sandbox.image and sandbox.env back; Agents
-- the migration bound, and that are still bound so, and the Sessions it froze
-- lose their Environment; the copies it made, and their builds, are deleted.
-- Agents and Sessions created since keep their Environment, which the
-- previous image understands. Apply once the previous image runs.
BEGIN;
SET LOCAL lock_timeout = '5s';

UPDATE oma.agents a SET
  sandbox = CASE WHEN m.sandbox ?| ARRAY['image', 'env']
    THEN COALESCE(a.sandbox, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('image', m.sandbox->'image', 'env', m.sandbox->'env'))
    ELSE a.sandbox END,
  environment_id = CASE WHEN a.environment_id = COALESCE(m.copied_environment_id, 'env_video_production')
    THEN m.environment_id ELSE a.environment_id END
FROM oma.migration_0029_agents m WHERE m.agent_id = a.id;

UPDATE oma.sessions s SET
  agent = CASE WHEN m.agent_sandbox ?| ARRAY['image', 'env']
    THEN jsonb_set(s.agent, '{sandbox}', COALESCE(s.agent->'sandbox', '{}'::jsonb)
      || jsonb_strip_nulls(jsonb_build_object('image', m.agent_sandbox->'image', 'env', m.agent_sandbox->'env')))
    ELSE s.agent END,
  environment_id = m.environment_id
FROM oma.migration_0029_sessions m WHERE m.session_id = s.id;

DELETE FROM oma.environment_builds WHERE environment_id IN (
  SELECT copied_environment_id FROM oma.migration_0029_agents WHERE copied_environment_id IS NOT NULL);
DELETE FROM oma.environments WHERE id IN (
  SELECT copied_environment_id FROM oma.migration_0029_agents WHERE copied_environment_id IS NOT NULL);

DROP TABLE oma.migration_0029_sessions;
DROP TABLE oma.migration_0029_agents;
COMMIT;
