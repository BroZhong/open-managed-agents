-- Apply before deploying the API. No object-storage files are removed.
BEGIN;
ALTER TABLE oma.workspaces ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE oma.sessions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

LOCK TABLE oma.skills IN SHARE ROW EXCLUSIVE MODE;
-- Keep the latest upload for each owner/name. Legacy creation times are unknown,
-- so updated_at is the fallback. Back up the superseded metadata for recovery.
CREATE TEMP TABLE skill_name_replacements ON COMMIT DROP AS
SELECT skill_id AS old_id, tenant_id,
       first_value(skill_id) OVER (
         PARTITION BY tenant_id, owner_type, owner_id, name
         ORDER BY COALESCE(created_at, updated_at) DESC, updated_at DESC, skill_id DESC
       ) AS keep_id
FROM oma.skills;
DELETE FROM skill_name_replacements WHERE old_id = keep_id;
CREATE TABLE IF NOT EXISTS oma.skill_name_duplicate_backup (LIKE oma.skills INCLUDING DEFAULTS);
INSERT INTO oma.skill_name_duplicate_backup
SELECT s.* FROM oma.skills s JOIN skill_name_replacements r
ON s.tenant_id = r.tenant_id AND s.skill_id = r.old_id;

UPDATE oma.skills s SET source_skill_id = r.keep_id
FROM skill_name_replacements r
WHERE s.tenant_id = r.tenant_id AND s.source_skill_id = r.old_id;
UPDATE oma.agents a SET skills = (
  SELECT COALESCE(jsonb_agg(DISTINCT COALESCE(r.keep_id, value)), '[]'::jsonb)
  FROM jsonb_array_elements_text(a.skills) AS ids(value)
  LEFT JOIN skill_name_replacements r ON r.tenant_id = a.tenant_id AND r.old_id = value
) WHERE jsonb_typeof(a.skills) = 'array';
UPDATE oma.sessions s SET agent = jsonb_set(agent, '{skills}', (
  SELECT COALESCE(jsonb_agg(DISTINCT COALESCE(r.keep_id, value)), '[]'::jsonb)
  FROM jsonb_array_elements_text(s.agent->'skills') AS ids(value)
  LEFT JOIN skill_name_replacements r ON r.tenant_id = s.tenant_id AND r.old_id = value
)) WHERE jsonb_typeof(s.agent->'skills') = 'array';
DELETE FROM oma.skills s USING skill_name_replacements r
WHERE s.tenant_id = r.tenant_id AND s.skill_id = r.old_id;
CREATE UNIQUE INDEX IF NOT EXISTS skills_owner_name_unique
  ON oma.skills (tenant_id, owner_type, owner_id, name);
COMMIT;
