// Explicit production acceptance, run with node --import tsx in the deployed Runner (SDK credentials remain Runner-owned).
// Exercises only a new verification tenant; keys revoked in finally. Keep evidence
// across Pod replacement. No service fault injection or business Sandbox selection.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire('/app/server/packages/store/package.json');
const { Pool } = require('pg');
const { Sandbox, SandboxNotFoundError } = createRequire('/app/server/packages/sandbox/package.json')('e2b');
const { PgApiKeyStore } = await import('/app/server/packages/store/src/postgres/api-key-store.ts');
const [phase, file] = process.argv.slice(2);
assert(file && ['init', 'reuse', 'paused', 'rebuild', 'child', 'recover-tool', 'terminate', 'cleanup'].includes(phase));
let evidence;
try { evidence = JSON.parse(await readFile(file, 'utf8')); }
catch (error) {
  assert.equal(error.code, 'ENOENT'); assert.equal(phase, 'init');
  evidence = { runId: `native-production-${Date.now()}`, checks: [], sandboxes: [], sessions: [] };
}
assert.match(evidence.runId, /^native-production-\d+$/);
const pool = new Pool({ host: process.env.PG_HOST, port: Number(process.env.PG_PORT), user: process.env.PG_USER,
  password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE, options: '-c search_path=oma', max: 2, connectionTimeoutMillis: 10000 });
const keys = new PgApiKeyStore(pool);
const key = await keys.create(evidence.runId, phase);
const headers = { 'x-api-key': key.rawKey, 'content-type': 'application/json' };
const sdk = { apiKey: process.env.E2B_API_KEY, domain: process.env.E2B_DOMAIN, requestTimeoutMs: 185000 };
const base = 'https://agentry.welltop.tech/api';
const save = () => writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
async function check(name, ok, data) {
  evidence.checks.push({ at: new Date().toISOString(), phase, name, ok: Boolean(ok), data }); await save();
  console.log(JSON.stringify({ name, ok: Boolean(ok), data })); assert(ok, name);
}
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + path, { method, headers, signal: AbortSignal.timeout(60000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(`API ${response.status} ${path}`);
  if (response.status === 204) return null;
  return response.json();
}
async function wait(label, read, accept, timeout = 240000) {
  const end = Date.now() + timeout; let nextLog = 0;
  while (Date.now() < end) {
    const value = await read(); if (accept(value)) return value;
    if (Date.now() >= nextLog) { console.log(JSON.stringify({ waiting: label })); nextLog = Date.now() + 15000; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Timeout ${label}`);
}
async function events(id) {
  let after = 0; const result = [];
  for (let page = 0; page < 30; page++) {
    const data = await api(`/v1/sessions/${id}/events?after_seq=${after}&limit=1000`);
    result.push(...data.data); if (!data.has_more) return result; after = data.data.at(-1).seq;
  }
  throw new Error('Event pagination incomplete');
}
const binding = async () => (await pool.query(`SELECT e.sandbox_id,e.creating_since FROM delegation_environments e JOIN sessions s ON s.id=e.id WHERE s.tenant_id=$1 AND s.id=$2`, [evidence.runId, evidence.root])).rows[0];
async function ownedSandbox() {
  const row = await binding(); assert(row?.sandbox_id);
  const info = await Sandbox.getInfo(row.sandbox_id, sdk);
  assert.equal(info.metadata['oma.dev/binding'], evidence.root);
  assert.equal(info.metadata['oma.dev/tenant'], evidence.runId);
  if (!evidence.sandboxes.includes(row.sandbox_id)) { evidence.sandboxes.push(row.sandbox_id); await save(); }
  return { id: row.sandbox_id, info };
}
async function run(text, allowUncertainty = false) {
  const before = await events(evidence.root);
  const completed = before.filter(event => event.type === 'session.turn_completed').length;
  await api(`/v1/sessions/${evidence.root}/events`, { events: [{ type: 'user.message', data: { content: [{ type: 'text', text }] } }] });
  const result = await wait('Turn completion', () => events(evidence.root), rows => rows.filter(event => event.type === 'session.turn_completed').length > completed);
  const newEvents = result.filter(event => event.seq > (before.at(-1)?.seq ?? 0));
  await check(allowUncertainty ? 'Turn completed; only expected uncertainty diagnostic allowed' : 'Turn completed without interruption or session error', !newEvents.some(event => event.type === 'session.turn_aborted' || (event.type === 'session.error' && !(allowUncertainty && event.data?.error?.code === 'workspace_storage_error'))));
  return newEvents;
}
async function idleDeadline() {
  await wait('idle deadline', async () => {
    const { id, info } = await ownedSandbox(); return { id, seconds: (new Date(info.endAt).getTime() - Date.now()) / 1000 };
  }, state => state.seconds > 1650 && state.seconds <= 1805);
  const { id, info } = await ownedSandbox();
  await check('idle deadline is approximately 30 minutes', true, { id, remainingSeconds: Math.round((new Date(info.endAt).getTime() - Date.now()) / 1000) });
}
try {
  if (phase === 'init') {
    assert(!evidence.root);
    evidence.agent = (await api('/v1/agents', { name: evidence.runId, runtime: 'pi-agent', model: 'openai-codex/gpt-5.6-sol', sandbox: { enabled: true }, skills: [], mcpServers: [], system: 'Follow verification instructions precisely. Use bash for requested commands only. No web, MCP or delegation unless explicitly requested. Children never delegate. Preserve tool errors honestly.' })).id;
    await save();
    const session = await api('/v1/sessions', { agent: evidence.agent, workspace_name: evidence.runId });
    evidence.root = session.id; evidence.workspace = session.workspaceId; evidence.sessions.push(session.id); await save();
    await check('Session creation stays cold', !(await binding())?.sandbox_id);
    await run('Reply exactly CHAT_ONLY. Do not use any tools.');
    await check('pure chat stays cold', !(await binding())?.sandbox_id);
    const command = `printf %s ${evidence.runId} > /home/user/workspace/native-production.txt; cat /home/user/workspace/native-production.txt`;
    const result = await run(`Call bash exactly once with command ${JSON.stringify(command)}. Then reply SAVED.`);
    await check('real Pi tool wrote the verification marker', result.some(event => event.type === 'agent.tool_result' && !event.data?.isError && JSON.stringify(event.data).includes(evidence.runId)));
    await ownedSandbox(); await idleDeadline();
  } else if (phase === 'reuse' || phase === 'paused' || phase === 'rebuild') {
    const original = (await ownedSandbox()).id;
    if (phase === 'paused') {
      await Sandbox.pause(original, sdk);
      await wait('Paused control-plane state', () => Sandbox.getInfo(original, sdk), info => info.state === 'paused');
    }
    if (phase === 'rebuild') {
      await Sandbox.kill(original, sdk);
      await wait('confirmed removal', async () => {
        try { await Sandbox.getInfo(original, sdk); return false; }
        catch (error) { if (error instanceof SandboxNotFoundError) return true; throw error; }
      }, Boolean);
    }
    const result = await run('Call bash exactly once with command "cat /home/user/workspace/native-production.txt". Then reply FILE_VERIFIED.');
    await check('saved OSS file is readable', result.some(event => event.type === 'agent.tool_result' && !event.data?.isError && JSON.stringify(event.data).includes(evidence.runId)));
    const current = (await ownedSandbox()).id;
    await check(phase === 'rebuild' ? 'confirmed deletion rebuilds with a new ID' : 'Turn reuses the same Sandbox ID', phase === 'rebuild' ? current !== original : current === original, { original, current });
    await idleDeadline();
  } else if (phase === 'child') {
    const args = { prompt: 'Use bash exactly once: "sleep 15; cat /home/user/workspace/native-production.txt". Then reply CHILD_VERIFIED. Do not delegate.', run_in_background: false };
    const result = await run(`Call Agent exactly once using these arguments: ${JSON.stringify(args)}. After the child finishes reply PARENT_VERIFIED.`);
    const executions = (await api(`/v1/sessions/${evidence.root}/delegations`)).data;
    await check('one child execution completed', executions.length === 1 && executions[0].status === 'completed');
    evidence.sessions.push(executions[0].childId); await save();
    const child = (await pool.query('SELECT delegation FROM sessions WHERE id=$1 AND tenant_id=$2', [executions[0].childId, evidence.runId])).rows[0];
    await check('Child Session inherits parent binding', child?.delegation?.sandboxSessionId === evidence.root);
    const trace = await events(executions[0].childId);
    await check('child read shared OSS file', trace.some(event => event.type === 'agent.tool_result' && !event.data?.isError && JSON.stringify(event.data).includes(evidence.runId)));
    await check('parent retained delegation history', result.some(event => event.type === 'agent.tool_use' && event.data?.name === 'Agent'));
    await idleDeadline();
  } else if (phase === 'recover-tool') {
    const { id } = await ownedSandbox();
    const effectFile = `native-recovery-effects-${Date.now()}.txt`;
    evidence.effectFiles ??= ['native-recovery-effects.txt'];
    evidence.effectFiles.push(effectFile); await save();
    const command = `printf '%s\\n' once >> /home/user/workspace/${effectFile}; echo ISSUED; sleep 60; echo COMPLETED`;
    // The model is told to inspect effects after an error, never blindly repeat.
    const execution = run(`Use bash with timeout=15 seconds and command ${JSON.stringify(command)} exactly once. If it errors, do not repeat it. Then use bash to cat /home/user/workspace/${effectFile} and report what happened. The environment may pause during this test.`, true).then(value => ({ value }), error => ({ error }));
    await wait('observable command side effect', async () => {
      try {
        const access = await api(`/v1/workspaces/${evidence.workspace}/files/${effectFile}`);
        const response = await fetch(access.url, { signal: AbortSignal.timeout(5000) });
        return response.ok && (await response.text()).includes('once');
      } catch { return false; }
    }, Boolean, 90000);
    await Sandbox.pause(id, sdk);
    const outcome = await execution; if (outcome.error) throw outcome.error;
    const result = outcome.value;
    await check('same Turn contains honest uncertain tool error', result.some(event => event.type === 'agent.tool_result' && event.data?.isError && JSON.stringify(event.data).includes('not replayed')));
    await check('same Turn continues with a successful inspection', result.some(event => event.type === 'agent.tool_result' && !event.data?.isError && JSON.stringify(event.data).includes('once')));
    const access = await api(`/v1/workspaces/${evidence.workspace}/files/${effectFile}`);
    const body = await (await fetch(access.url)).text();
    await check('uncertain command effect was not replayed', (body.match(/once/g) ?? []).length === 1);
    await check('recovered resource retains finite active deadline', (new Date((await ownedSandbox()).info.endAt).getTime() - Date.now()) < 86405000);
  } else if (phase === 'terminate') {
    const { id } = await ownedSandbox();
    await Sandbox.pause(id, sdk);
    await api(`/v1/sessions/${evidence.root}`, undefined, 'DELETE');
    await wait('production cleanup outbox', async () => (await pool.query('SELECT completed_at FROM session_cleanup WHERE session_id=$1', [evidence.root])).rows[0], row => row?.completed_at);
    await check('termination cleared binding', !(await binding())?.sandbox_id);
    await assert.rejects(Sandbox.getInfo(id, sdk), SandboxNotFoundError);
    await check('Paused Sandbox deleted', true, { id });
    const access = await api(`/v1/workspaces/${evidence.workspace}/files/native-production.txt`);
    const response = await fetch(access.url, { signal: AbortSignal.timeout(20000) });
    await check('OSS file remains after termination', response.ok && await response.text() === evidence.runId);
  } else {
    const rows = (await pool.query('SELECT id FROM sessions WHERE tenant_id=$1', [evidence.runId])).rows;
    for (const { id } of rows) await api(`/v1/sessions/${id}`, undefined, 'DELETE');
    for (const { id } of rows) await wait('test Session cleanup', async () => (await pool.query('SELECT completed_at FROM session_cleanup WHERE session_id=$1', [id])).rows[0], row => row?.completed_at);
    for (const id of evidence.sandboxes) await assert.rejects(Sandbox.getInfo(id, sdk), SandboxNotFoundError);
    if (evidence.workspace) {
      await api(`/v1/workspaces/${evidence.workspace}/files/content?path=native-production.txt`, undefined, 'DELETE');
      for (const path of evidence.effectFiles ?? []) await api(`/v1/workspaces/${evidence.workspace}/files/content?path=${encodeURIComponent(path)}`, undefined, 'DELETE');
    }
    if (evidence.agent) await api(`/v1/agents/${evidence.agent}`, undefined, 'DELETE');
    await check('test resources removed; audit history retained', true, { sessions: rows.map(row => row.id), sandboxes: evidence.sandboxes });
    evidence.cleanupConfirmed = true; await save();
  }
} catch (error) {
  evidence.checks.push({ at: new Date().toISOString(), phase, ok: false, errorType: error?.name ?? 'Error', ...(error instanceof assert.AssertionError ? { assertion: error.message } : {}) });
  await save(); console.log(JSON.stringify({ failed: true, phase, errorType: error?.name })); process.exitCode = 1;
} finally { await keys.revoke(evidence.runId, key.apiKey.id); await pool.end(); }
