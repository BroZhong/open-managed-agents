import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSkill, resolveSiblingLinks } from './provision.mjs';

test('imports existing Skill references and ignores local caches and hidden credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'auto-story-skill-'));
  try {
    await mkdir(join(dir, 'reference'));
    await writeFile(join(dir, 'SKILL.md'), '---\nname: existing-skill\ndescription: existing\n---\nRead reference/tool.md');
    await writeFile(join(dir, 'reference/tool.md'), 'actual instructions');
    await writeFile(join(dir, '.env'), 'SECRET=never-import');
    const skill = await readSkill(dir);
    assert.equal(skill.name, 'existing-skill');
    assert.deepEqual(skill.files.map(f => f.path), ['reference/tool.md', 'SKILL.md']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('resolves cross-Skill references to equipped fork ids, preserving unrelated links', () => {
  assert.equal(resolveSiblingLinks('[query](../byted-mediakit-shared/reference/query_task.md) ../unknown/file', {
    'byted-mediakit-shared': 'skill_shared_fork',
  }), '[query](/skills/skill_shared_fork/reference/query_task.md) ../unknown/file');
});
