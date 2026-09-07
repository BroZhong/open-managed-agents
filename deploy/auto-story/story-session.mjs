#!/usr/bin/env node
// Start or inspect a real, staged narration Skill acceptance Session.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = fileURLToPath(new URL('.', import.meta.url));
const [action, id, argument, destination] = process.argv.slice(2);
const base = (process.env.OMA_API_URL || 'https://agentry.welltop.tech/api').replace(/\/$/, '');
const auth = process.env.OMA_BEARER_TOKEN ? { authorization: `Bearer ${process.env.OMA_BEARER_TOKEN}` } : { 'x-api-key': process.env.OMA_API_KEY };
if (!Object.values(auth)[0]) throw new Error('Set OMA_API_KEY or OMA_BEARER_TOKEN privately');
async function request(path, method = 'GET', body) {
  const r = await fetch(base + path, { method, headers: { ...auth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status}`);
  const text = await r.text();
  if (!text) return;
  try { return JSON.parse(text); } catch { return text; }
}
const send = (sessionId, prompt) => request(`/v1/sessions/${sessionId}/events`, 'POST', { events: [{ type: 'user.message', data: { content: [{ type: 'text', text: prompt }] } }] });
async function uploadHelpers(sessionId) {
  for (const name of await readdir(join(here, 'e2e'))) {
    if (!name.endsWith('.py') || name.startsWith('test_')) continue;
    await request(`/v1/sessions/${sessionId}/workspace/files/content`, 'PUT', { path: `auto-story-e2e/${name}`, content: await readFile(join(here, 'e2e', name), 'utf8') });
  }
}
if (action === 'start') {
  const output = resolve(argument);
  await mkdir(output, { recursive: true });
  const session = await request('/v1/sessions', 'POST', { agent: id, workspace_name: 'auto-story 第一人称故事验收' });
  await writeFile(join(output, 'session.json'), JSON.stringify({ agentId: id, sessionId: session.id, url: `${base.replace(/\/api$/, '')}/sessions/${session.id}` }, null, 2));
  await uploadHelpers(session.id);
  await send(session.id, await readFile(join(here, 'e2e/narration-brief.md'), 'utf8'));
  console.log(JSON.stringify({ sessionId: session.id, started: true }));
} else if (action === 'send') {
  await send(id, await readFile(resolve(argument), 'utf8'));
  console.log(JSON.stringify({ sessionId: id, submitted: true }));
} else if (action === 'helpers') {
  await uploadHelpers(id);
  console.log(JSON.stringify({ sessionId: id, helpersUpdated: true }));
} else if (action === 'file') {
  console.log(JSON.stringify(await request(`/v1/sessions/${id}/workspace/files/${argument.split('/').map(encodeURIComponent).join('/')}`), null, 2));
} else if (action === 'download') {
  if (!destination) throw new Error('download requires a local destination');
  const response = await fetch(`${base}/v1/sessions/${id}/workspace/files/${argument.split('/').map(encodeURIComponent).join('/')}`, { headers: auth, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Workspace download HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(resolve(destination), bytes, { flag: 'wx' });
  console.log(JSON.stringify({ sessionId: id, path: resolve(destination), bytes: bytes.length }));
} else if (action === 'status') {
  const session = await request(`/v1/sessions/${id}`);
  const page = await request(`/v1/sessions/${id}/events?after_seq=${Number(argument || 0)}&limit=500`);
  const interesting = page.data.filter(e => e.type.startsWith('session.') || ['agent.message', 'agent.tool_use', 'agent.tool_result'].includes(e.type));
  console.log(JSON.stringify({ sessionId: id, status: session.status, hasMore: page.has_more,
    nextSeq: Math.max(Number(argument || 0), ...page.data.map(e => e.seq)),
    events: interesting.map(e => ({ seq: e.seq, type: e.type, name: e.data?.name, isError: e.data?.isError,
      text: e.type === 'agent.tool_use' ? JSON.stringify(e.data.input).slice(0, 1000)
        : (e.data?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') || JSON.stringify(e.data)).slice(0, e.type === 'agent.message' ? 1800 : 500),
    })),
  }, null, 2));
} else throw new Error('Usage: story-session.mjs start <agent-id> <output-dir> | send <session-id> <prompt-file> | helpers <session-id> | status <session-id> [after-seq] | file <session-id> <workspace-path> | download <session-id> <workspace-path> <local-destination>');
