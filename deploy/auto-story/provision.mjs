#!/usr/bin/env node
// Import existing local Skills, then equip their independent forks (ADR-0004).
// No skill copies or credentials are bundled into the repository or image.
import { readFile, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
export async function readSkill(directory) {
  const files = [];
  async function visit(dir, prefix = '') {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || ['node_modules', '__pycache__'].includes(entry.name)) continue;
      const path = prefix + entry.name;
      if (entry.isDirectory()) await visit(join(dir, entry.name), path + '/');
      else if (entry.isFile()) files.push({ path, content: await readFile(join(dir, entry.name), 'utf8') });
      else throw new Error(`Unsupported symlink in Skill: ${path}`);
    }
  }
  await visit(directory);
  const skillMd = files.find(f => f.path === 'SKILL.md');
  if (!skillMd) throw new Error(`Missing SKILL.md: ${directory}`);
  const name = /^name:\s*["']?([^\n"']+)/m.exec(skillMd.content)?.[1]?.trim() || basename(directory);
  return { name, directory, files };
}

// Forks have opaque ids. Keep the original cross-Skill reference valid by
// adapting only those links to the equipped sibling's real projection path.
export function resolveSiblingLinks(content, siblings) {
  return content.replace(/\.\.\/([A-Za-z0-9_-]+)\//g, (original, name) =>
    siblings[name] ? `/skills/${siblings[name]}/` : original);
}

export function defaultSkillDirectories() {
  const codex = process.env.AUTO_STORY_SKILL_ROOT || join(homedir(), '.codex/skills');
  const vfs = process.env.AUTO_STORY_VFS_SKILL || join(homedir(), 'github/vfs-cli/internal/skills/data/vfs-cli');
  return ['shared', 'audio', 'editing', 'image', 'video'].map(domain => join(codex, `byted-mediakit-${domain}`))
    .concat([vfs, join(codex, 'video-analysis')]);
}

export async function provision({ baseUrl, apiKey, bearer, directories, dryRun = false, skillsOnly = false }) {
  const definition = JSON.parse(await readFile(join(here, 'agent.json'), 'utf8'));
  if (process.env.AUTO_STORY_MODEL) definition.model = process.env.AUTO_STORY_MODEL;
  const local = await Promise.all(directories.map(readSkill));
  if (new Set(local.map(s => s.name)).size !== local.length) throw new Error('Duplicate local Skill names');
  if (dryRun) return { agent: definition, skills: local.map(s => ({ name: s.name, files: s.files.length, source: s.directory })) };
  if (!apiKey && !bearer) throw new Error('Set OMA_API_KEY or OMA_BEARER_TOKEN privately');
  const base = baseUrl.replace(/\/$/, '');
  const headers = bearer ? { authorization: `Bearer ${bearer}` } : { 'x-api-key': apiKey };
  async function request(path, options = {}) {
    const response = await fetch(`${base}${path}`, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`OMA ${options.method || 'GET'} ${path}: HTTP ${response.status}`);
    return response.json();
  }
  const post = (path, body) => request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  async function list(path) {
    const records = [];
    let cursor;
    do {
      const page = await request(`${path}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      records.push(...page.data);
      cursor = page.has_more ? page.next_cursor : undefined;
      if (page.has_more && !cursor) throw new Error(`Missing cursor: ${path}`);
    } while (cursor);
    return records;
  }
  const matching = (await list('/v1/agents')).filter(a => a.name === definition.name);
  if (matching.length > 1) throw new Error('Multiple auto-story Agents exist; resolve the duplicate before provisioning');
  const agent = matching[0] || await post('/v1/agents', definition);
  if (matching[0] && !skillsOnly) await post(`/v1/agents/${agent.id}`, { ...definition, sandbox: { ...agent.sandbox, ...definition.sandbox, env: { ...agent.sandbox?.env, ...definition.sandbox.env } } });
  const libraries = await list('/v1/skills');
  const equipped = [];
  for (const skill of local) {
    const matches = libraries.filter(s => s.name === skill.name);
    if (matches.length > 1) throw new Error(`Multiple Library Skills named ${skill.name}; resolve before provisioning`);
    let library = matches[0];
    if (!library) {
      const form = new FormData();
      form.append('paths', JSON.stringify(skill.files.map(f => f.path)));
      for (const file of skill.files) form.append('files', new File([file.content], file.path));
      library = (await request('/v1/skills', { method: 'POST', body: form })).data[0];
    }
    const fork = await post(`/v1/agents/${agent.id}/skills`, { skillId: library.id });
    // Refresh only this Agent's copy with the user-selected local files; other
    // Agents and the shared Library retain their independent versions.
    const existing = await request(`/v1/skills/${fork.id}`);
    const localPaths = new Set(skill.files.map(f => f.path));
    for (const file of existing.files) {
      const path = typeof file === 'string' ? file : file.path;
      if (path && !localPaths.has(path)) await request(`/v1/skills/${fork.id}/files/content?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
    }
    equipped.push({ ...skill, id: fork.id, sourceSkillId: library.id });
  }
  const siblings = Object.fromEntries(equipped.flatMap(s => [[s.name, s.id], [basename(s.directory), s.id]]));
  for (const skill of equipped) {
    for (const file of skill.files) {
      await request(`/v1/skills/${skill.id}/files/content`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: file.path, content: resolveSiblingLinks(file.content, siblings) }),
      });
    }
  }
  return { agentId: agent.id, model: skillsOnly ? agent.model : definition.model, sandbox: skillsOnly ? agent.sandbox?.image : definition.sandbox.image,
    skills: equipped.map(s => ({ id: s.id, name: s.name, files: s.files.length })),
    url: `${base.replace(/\/api$/, '')}/agents/${agent.id}` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const directories = args.filter(a => !['--dry-run', '--skills-only'].includes(a));
    console.log(JSON.stringify(await provision({
      baseUrl: process.env.OMA_API_URL || 'https://agentry.welltop.tech/api',
      apiKey: process.env.OMA_API_KEY, bearer: process.env.OMA_BEARER_TOKEN,
      directories: directories.length ? directories : defaultSkillDirectories(), dryRun: args.includes('--dry-run'), skillsOnly: args.includes('--skills-only'),
    }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
