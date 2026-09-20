import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pi from '@earendil-works/pi-coding-agent';
assert.equal(pi.VERSION, '0.83.0');
const cwd = await mkdtemp(join(tmpdir(), 'oma-pi-smoke-'));
const invoke = (factory, args) => factory(cwd).execute('smoke', args, undefined, undefined, { cwd });
try {
  await invoke(pi.createWriteToolDefinition, { path: 'note.txt', content: 'before 中文\n' });
  const read = await invoke(pi.createReadToolDefinition, { path: 'note.txt' });
  assert.equal(read.content[0].text, 'before 中文\n');
  await invoke(pi.createEditToolDefinition, { path: 'note.txt', edits: [{ oldText: 'before', newText: 'after' }] });
  assert.equal(await readFile(join(cwd, 'note.txt'), 'utf8'), 'after 中文\n');
  assert.match((await invoke(pi.createLsToolDefinition, { path: '.' })).content[0].text, /note.txt/);
  assert.match((await invoke(pi.createFindToolDefinition, { pattern: '*.txt' })).content[0].text, /note.txt/);
  assert.match((await invoke(pi.createGrepToolDefinition, { pattern: 'after' })).content[0].text, /note.txt:1: after 中文/);
  const bash = pi.createBashToolDefinition(cwd, { exposeSessionEnvironment: false });
  assert.equal((await bash.execute('bash', { command: "printf 'sandbox-pi-ok'" })).content[0].text, 'sandbox-pi-ok');
  console.log(JSON.stringify({ version: pi.VERSION, tools: ['read','write','edit','ls','find','grep','bash'], ok: true }));
} finally { await rm(cwd, { recursive: true, force: true }); }
