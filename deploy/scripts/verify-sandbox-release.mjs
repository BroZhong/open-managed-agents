#!/usr/bin/env node
// Run inside the production Server with tsx. Credentials remain in memory.
// Explicitly isolated tenant; never resumes, modifies or terminates user Sessions.
import assert from 'node:assert/strict';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const phase = process.argv[2];
assert(['init', 'exercise', 'shared', 'audit', 'inspect', 'rebuild', 'cleanup'].includes(phase), 'Expected init|exercise|shared|audit|inspect|rebuild|cleanup');
const evidencePath = process.argv[3] ?? '/tmp/oma-sandbox-release.json';
const root = '/app';
const require = createRequire(import.meta.url);
const { Pool } = require(`${root}/server/packages/store/node_modules/pg`);
const { PgApiKeyStore } = await import(pathToFileURL(`${root}/server/packages/store/src/postgres/api-key-store.ts`).href);
const pool = new Pool({ host: process.env.PG_HOST, port: Number(process.env.PG_PORT ?? 5432), database: process.env.PG_DATABASE, user: process.env.PG_USER, password: process.env.PG_PASSWORD, options: '-c search_path=oma', max: 2, connectionTimeoutMillis: 10000 });
let evidence;
try { evidence = JSON.parse(await readFile(evidencePath, 'utf8')); }
catch (e) { if (e.code !== 'ENOENT' || phase !== 'init') throw e; const runId = `sandbox-release-${Date.now()}`; evidence = { runId, tenant: runId, startedAt: new Date().toISOString(), sessions: {}, checks: [], observations: [] }; }
assert(evidence.tenant === evidence.runId && /^sandbox-release-\d+$/.test(evidence.tenant));
const keys = new PgApiKeyStore(pool);
let key;
const base = process.env.OMA_LIVE_BASE_URL ?? 'https://agentry.welltop.tech/api';
async function save() { await writeFile(`${evidencePath}.tmp`, JSON.stringify(evidence, null, 2), { mode: 0o600 }); await rename(`${evidencePath}.tmp`, evidencePath); }
function check(name, ok, details) { evidence.checks.push({ phase, name, ok: Boolean(ok), details, at: new Date().toISOString() }); assert(ok, name); }
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const r = await fetch(base + path, { method, headers: { 'x-api-key': key.rawKey, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000) });
  assert(r.ok, `API ${method} ${path}: ${r.status}`); return r.json();
}
async function events(id) {
  let after = 0; const all = [];
  for (let i = 0; i < 100; i++) { const page = await api(`/v1/sessions/${id}/events?after_seq=${after}&limit=200`); all.push(...page.data); if (!page.has_more || !page.data.length) return all; after = page.data.at(-1).seq; }
  throw new Error('Event pagination exceeded');
}
async function wait(label, read, ready, timeout = 600000) {
  const end = Date.now() + timeout; let nextLog = 0;
  while (Date.now() < end) { const value = await read(); if (ready(value)) return value; if (Date.now() > nextLog) { console.log(JSON.stringify({ phase, waiting: label, at: new Date().toISOString() })); nextLog = Date.now() + 30000; } await new Promise(r => setTimeout(r, 2000)); }
  throw new Error(`Timed out: ${label}`);
}
async function send(s, text) {
  const after = (await events(s.id)).at(-1)?.seq ?? 0;
  await api(`/v1/sessions/${s.id}/events`, { events: [{ type: 'user.message', data: { content: [{ type: 'text', text }] } }] });
  return after;
}
async function completed(s, after) {
  const es = await wait('completed Turn', () => events(s.id), es => {
    assert(!es.some(e => e.seq > after && ['session.error', 'session.turn_aborted'].includes(e.type)), 'Turn must not error or abort');
    return es.some(e => e.seq > after && e.type === 'session.turn_completed');
  });
  const relevant = es.filter(e => e.seq > after);
  check('real model request and successful Sandbox tool result', relevant.some(e => e.type === 'span.model_request_end') && relevant.some(e => e.type === 'agent.tool_result' && !e.data?.isError));
  evidence.observations.push({ phase, sessionId: s.id, events: relevant.filter(e => ['session.turn_completed', 'agent.tool_use', 'agent.tool_result', 'agent.message'].includes(e.type)) });
  await save(); return relevant;
}
function successfulCommand(es, command, expected) {
  const calls = es.filter(e => e.type === 'agent.tool_use' && e.data?.name === 'bash' && e.data.input?.command === command);
  return es.some(e => e.type === 'agent.tool_result' && !e.data?.isError && calls.some(c => c.data.toolUseId === e.data.toolUseId) && JSON.stringify(e.data.content).includes(expected));
}
async function state() {
  const ids = Object.values(evidence.sessions).map(s => s.id);
  return (await pool.query(`SELECT e.id, e.sandbox_id, e.lifecycle_managed, e.idle_since, e.reclaiming,
    (SELECT count(*)::int FROM sandbox_activities a WHERE a.binding_id=e.id) AS activities,
    (SELECT count(*)::int FROM pending_events p JOIN sessions s ON s.id=p.session_id WHERE COALESCE(s.delegation->>'sandboxSessionId',s.id)=e.id) AS inputs
    FROM delegation_environments e WHERE e.id=ANY($1) ORDER BY e.id`, [ids])).rows;
}
async function file(s, name) {
  const access = await api(`/v1/workspaces/${s.workspaceId}/files/${name}`);
  const r = await fetch(access.url, { signal: AbortSignal.timeout(60000) }); assert(r.ok, 'Workspace download'); return r.text();
}
try {
  key = await keys.create(evidence.tenant, `${evidence.runId}-${phase}`);
  if (phase === 'init') {
    assert(!evidence.agentId, 'init is not repeatable');
    const a = await api('/v1/agents', { name: evidence.runId, description: 'Isolated production Sandbox lifecycle verification #172–#176', model: 'openai-codex/gpt-5.6-sol', runtime: 'pi-agent', sandbox: { enabled: true }, mcpServers: [], skills: [], system: 'Execute release verification instructions precisely using Sandbox bash. Use Agent only when explicitly requested. Children never delegate. Do not use MCP or Web. On background result notification reply Acknowledged and do nothing else.' });
    evidence.agentId = a.id; await save();
    const idle = await api('/v1/sessions', { agent: a.id, workspace_name: evidence.runId });
    evidence.sessions.idle = { id: idle.id, workspaceId: idle.workspaceId }; await save();
    for (const name of ['shared', 'independent']) { const s = await api('/v1/sessions', { agent: a.id, workspace_id: idle.workspaceId }); evidence.sessions[name] = { id: s.id, workspaceId: s.workspaceId }; await save(); }
    const rows = (await pool.query('SELECT sandbox_id FROM delegation_environments WHERE id=ANY($1)', [Object.values(evidence.sessions).map(s => s.id)])).rows;
    check('cold Sessions create no Sandbox', rows.every(r => !r.sandbox_id));
  } else if (phase === 'exercise' || phase === 'shared') {
    const { idle, shared, independent } = evidence.sessions;
    assert(process.env.SANDBOX_IDLE_SWEEP !== 'false', 'Lifecycle sweep is explicitly disabled on deployed Host');
    const token = `PERSIST_${evidence.runId}`; evidence.token = token;
    if (phase === 'exercise') {
    const cmd = `printf %s ${token} > /home/user/workspace/lifecycle-release.txt; printf %s ${token} > /tmp/lifecycle-release-marker; cat /home/user/workspace/lifecycle-release.txt /tmp/lifecycle-release-marker`;
    await completed(idle, await send(idle, `Call Sandbox bash exactly once with command ${JSON.stringify(cmd)}. Verify both outputs, then reply SAVED.`));
    check('saved Workspace bytes available via public API', await file(idle, 'lifecycle-release.txt') === token);
    const independentCmd = 'test ! -e /tmp/lifecycle-release-marker && cat /home/user/workspace/lifecycle-release.txt';
    const independentEvents = await completed(independent, await send(independent, `Call Sandbox bash with command ${JSON.stringify(independentCmd)}. Verify success and reply INDEPENDENT.`));
    check('independent Sandbox read saved file with original temporary marker absent', successfulCommand(independentEvents, independentCmd, token));
    }
    const childPrompt = `Call Sandbox bash exactly once with command "sleep 90; cat /tmp/lifecycle-shared-marker". Verify output equals ${token}, then reply CHILD_DONE. Do not delegate.`;
    const after = await send(shared, `First call Sandbox bash with command "printf %s ${token} > /tmp/lifecycle-shared-marker". Then call Agent exactly once using ONLY these exact arguments: ${JSON.stringify({ prompt: childPrompt, run_in_background: true })}. Omit resume, thinking and subagent_type entirely: these are OPTIONAL fields, and resume is only for an existing real child ID. Do not invent a child ID or pass placeholders. Do not add any other argument. If the tool fails, report failure without retrying. Reply PARENT_DONE as soon as Agent returns. Do not wait or call other tools.`);
    await completed(shared, after);
    const xs = (await api(`/v1/sessions/${shared.id}/delegations?limit=100`)).data;
    check('completed parent actually created requested child', xs.length > 0);
    const x = xs.at(-1); evidence.childId = x.childId; evidence.executionId = x.id;
    check('parent settles before background child', ['queued', 'running'].includes(x.status), { status: x.status });
    let rows = await state(); const sharedRow = rows.find(r => r.id === shared.id);
    check('shared binding retains activity or queued input after parent completion', sharedRow.activities + sharedRow.inputs > 0 && sharedRow.idle_since === null, sharedRow);
    check('independent Sessions sharing Workspace have distinct Sandboxes', new Set(rows.map(r => r.sandbox_id)).size === 3 && rows.every(r => r.sandbox_id && r.lifecycle_managed), rows);
    evidence.originalBindings = rows; await save();
    const done = await wait('background child and notification settled', async () => (await api(`/v1/sessions/${shared.id}/delegations?limit=100`)).data.find(y => y.id === x.id), y => y.status === 'completed' && y.notificationStatus === 'processed');
    const childEvents = await events(x.childId);
    check('child read original temporary file', successfulCommand(childEvents, 'sleep 90; cat /tmp/lifecycle-shared-marker', token));
    evidence.observations.push({ phase, child: { id: x.childId, status: done.status, notificationStatus: done.notificationStatus } });
    rows = await wait('confirmed idle timers', state, rows => rows.length === 3 && rows.every(r => r.activities === 0 && r.inputs === 0 && r.idle_since), 120000);
    evidence.idleStart = rows; check('confirmed idle recorded after all real work settled', true, rows);
  } else if (phase === 'audit') {
    const independent = await events(evidence.sessions.independent.id);
    check('exact independent-Sandbox command succeeded', successfulCommand(independent, 'test ! -e /tmp/lifecycle-release-marker && cat /home/user/workspace/lifecycle-release.txt', evidence.token));
    const child = await events(evidence.childId);
    check('exact child command waited and read original temporary file', successfulCommand(child, 'sleep 90; cat /tmp/lifecycle-shared-marker', evidence.token));
    const parent = await events(evidence.sessions.shared.id);
    const calls = parent.filter(e => e.type === 'agent.tool_use' && e.data?.name === 'Agent' && !Object.hasOwn(e.data.input, 'resume'));
    check('corrected provider allowed new-child call without resume', parent.some(e => e.type === 'agent.tool_result' && !e.data?.isError && calls.some(c => c.data.toolUseId === e.data.toolUseId)));
    evidence.observations.push({ phase, at: new Date().toISOString(), childEvents: child.filter(e => ['agent.tool_use', 'agent.tool_result', 'session.turn_completed'].includes(e.type)) });
  } else if (phase === 'inspect') {
    const rows = await state(); evidence.observations.push({ phase, at: new Date().toISOString(), rows }); console.log(JSON.stringify({ phase, rows }));
  } else if (phase === 'rebuild') {
    assert(evidence.idleStart?.length === 3);
    const earliest = Math.min(...evidence.idleStart.map(r => Date.parse(r.idle_since)));
    const idleIds = [evidence.sessions.idle.id, evidence.sessions.independent.id];
    while (Date.now() - earliest < 1800000) {
      const beforeRead = Date.now();
      const rows = await state();
      // Leave a five-second margin for the read itself crossing the boundary.
      if (beforeRead - earliest < 1795000) assert(rows.filter(r => idleIds.includes(r.id)).every(r => r.sandbox_id && !r.reclaiming), 'Sandbox was reclaimed before the full idle period');
      console.log(JSON.stringify({ phase, waiting: 'full real 30-minute idle period', elapsedSeconds: Math.floor((Date.now() - earliest) / 1000), at: new Date().toISOString() }));
      await new Promise(resolve => setTimeout(resolve, Math.min(30000, Math.max(1, earliest + 1800000 - Date.now()))));
    }
    const rows = await wait('production sweeper deletes original idle bindings', state, rows => rows.length === 3 && rows.filter(r => idleIds.includes(r.id)).every(r => !r.sandbox_id && !r.reclaiming), 180000);
    check('real production sweeper reclaimed after full idle period', true, { elapsedMs: Date.now() - earliest, rows });
    const shared = rows.find(r => r.id === evidence.sessions.shared.id);
    const sharedIdleStart = evidence.idleStart.find(r => r.id === shared.id).idle_since;
    if (Date.now() - Date.parse(sharedIdleStart) < 1800000) {
      check('later-settled shared binding retains its own full idle period', shared.sandbox_id === evidence.originalBindings.find(r => r.id === shared.id).sandbox_id && !shared.reclaiming, shared);
    }
    const s = evidence.sessions.idle;
    const cmd = 'test ! -e /tmp/lifecycle-release-marker && cat /home/user/workspace/lifecycle-release.txt';
    const es = await completed(s, await send(s, `Call Sandbox bash once with command ${JSON.stringify(cmd)}. Do not create or repair any file. Verify output equals ${evidence.token}. Reply REBUILT.`));
    check('rebuilt Sandbox read saved bytes with temporary marker absent', successfulCommand(es, cmd, evidence.token));
    const after = (await state()).find(r => r.id === s.id);
    check('rebuilt binding uses new Sandbox identity', after.sandbox_id && after.sandbox_id !== evidence.originalBindings.find(r => r.id === s.id).sandbox_id, after);
    evidence.rebuiltBinding = after;
  } else if (phase === 'cleanup') {
    assert(evidence.checks.some(c => c.name === 'rebuilt binding uses new Sandbox identity' && c.ok), 'Successful rebuild required before cleanup');
    await wait('fixture activity settlement before cleanup', state, rows => rows.every(r => r.activities === 0 && r.inputs === 0), 30000);
    const ids = [evidence.childId, ...Object.values(evidence.sessions).map(s => s.id)].filter(Boolean);
    for (const id of ids) {
      const session = await api(`/v1/sessions/${id}`); const pending = await api(`/v1/sessions/${id}/pending`);
      assert(['idle', 'terminated'].includes(session.status) && pending.count === 0, `Refuse to terminate active fixture ${id}`);
      await api(`/v1/sessions/${id}`, undefined, 'DELETE');
    }
    const rows = await state(); check('cleanup retained no Sandbox or unresolved activity', rows.every(r => !r.sandbox_id && r.activities === 0 && r.inputs === 0), rows);
    evidence.cleanupAt = new Date().toISOString();
  }
  evidence.lastSuccess = { phase, at: new Date().toISOString() }; await save();
  console.log(JSON.stringify({ phase, ok: true, runId: evidence.runId, sessions: evidence.sessions, evidencePath }));
} catch (e) { evidence.failures ??= []; evidence.failures.push({ phase, message: e.message, at: new Date().toISOString() }); await save(); console.error(JSON.stringify({ phase, ok: false, error: e.message })); process.exitCode = 1; }
finally { if (key) await keys.revoke(evidence.tenant, key.apiKey.id); await pool.end(); }
