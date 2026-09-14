#!/usr/bin/env -S node --import tsx
/**
 * Opt-in, isolated Shanghai application acceptance. No production server/DB.
 * Real HTTP handlers, SessionRouter, SandboxManager, E2B and OSS are exercised.
 * The deterministic Adapter replaces only model/provider behavior. Skill bytes
 * are held in memory but go through the real S3ProvisionSource into E2B.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../../server/packages/api/src/app.js';
import { OSSArtifactStore, workspaceObjectPrefix } from '../../../server/packages/store/src/index.js';
import type { OSSObjectClient, Session } from '../../../server/packages/store/src/index.js';
import { createMemoryStores } from '../../../server/packages/store-memory/src/index.js';
import { InMemoryTurnStreamStore } from '../../../server/packages/redis/src/index.js';
import { InProcessEventStreamHub } from '../../../server/packages/event-log/src/index.js';
import { SessionRouter } from '../../../server/packages/session-router/src/index.js';
import { DefaultSandboxManager, E2BSandboxClient, S3ProvisionSource } from '../../../server/packages/sandbox/src/index.js';
import type { SandboxCreateOptions, SandboxHandle } from '../../../server/packages/sandbox/src/index.js';
import type { Adapter, AdapterInput, SessionEvent, ToolExecutor } from '../../../adapter/packages/core/src/index.js';

const DOMAIN = 'sandbox.agentry.welltop.tech';
const BUCKET = 'agentry';
const testId = randomUUID().replaceAll('-', '');
const workspaceId = `probe_app_${testId}`;
const reportPath = process.env.OMA_PROBE_REPORT ?? join(tmpdir(), `oma-application-${testId}.json`);
const events: Array<Record<string, unknown>> = [];
const failedChecks: string[] = [];
const report: Record<string, unknown> = {
  testId, startedAt: new Date().toISOString(), events, failedChecks,
  scope: 'real application HTTP handlers, SessionRouter, SandboxManager, E2B SDK and OSS SDK; in-memory control metadata/auth and Skill artifact source; deterministic Adapter, no LLM/provider or browser rendering claim',
};
function record(event: string, details: Record<string, unknown> = {}) {
  const entry = { at: new Date().toISOString(), event, ...details };
  events.push(entry);
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify(entry) + '\n');
}
function credentials() {
  const profile = JSON.parse(readFileSync(join(homedir(), '.aliyun/config.json'), 'utf8'))
    .profiles.find((entry: { name: string }) => entry.name === 'welltop');
  if (!profile?.access_key_id || !profile?.access_key_secret) {
    throw new Error('Authorized welltop AK profile is required');
  }
  let apiKey = process.env.E2B_API_KEY;
  if (!apiKey) {
    const kubeconfig = process.env.OMA_SHANGHAI_KUBECONFIG;
    if (!kubeconfig) throw new Error('E2B_API_KEY or explicit OMA_SHANGHAI_KUBECONFIG is required');
    const secret = JSON.parse(execFileSync('kubectl', [
      '--kubeconfig', kubeconfig, '--request-timeout=20s', '-n', 'oma-infra',
      'get', 'secret', 'oma-secrets', '-o', 'json',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    assert.equal(Buffer.from(secret.data.E2B_DOMAIN, 'base64').toString(), DOMAIN);
    apiKey = Buffer.from(secret.data.E2B_API_KEY, 'base64').toString();
  }
  return { accessKeyId: profile.access_key_id, accessKeySecret: profile.access_key_secret, apiKey };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, label: string, timeoutMs = 240000): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) => timeout.addEventListener('abort', () => reject(new Error(label)), { once: true })),
  ]);
}
async function shell(executor: ToolExecutor, python: string) {
  let output = '';
  for await (const chunk of executor.exec(['python3', '-c', python], { timeoutSeconds: 30 })) output += chunk.text;
  assert.ok(output.includes('OMA_PROBE_OK'), 'Sandbox command did not finish successfully');
}

async function main() {
  const credential = credentials();
  const requireStore = createRequire(new URL('../../../server/packages/store/package.json', import.meta.url));
  const AliOSS = requireStore('ali-oss');
  const cloud = new AliOSS({
    region: 'oss-cn-shanghai', bucket: BUCKET, accessKeyId: credential.accessKeyId, accessKeySecret: credential.accessKeySecret,
    endpoint: 'https://oss-cn-shanghai.aliyuncs.com', secure: true, authorizationV4: true,
  });
  let denyProbeReads = false;
  let denyListing = false;
  // Fault injection stays at the external storage boundary and affects only this
  // process's isolated app. Every non-injected call goes to actual OSS.
  const sdkBoundary: OSSObjectClient = {
    put: (...args) => cloud.put(...args),
    get: (key) => {
      if (denyProbeReads && key.includes('/.oma-workspace-checks/')) throw new Error('Injected probe read failure');
      return cloud.get(key);
    },
    head: (...args) => cloud.head(...args),
    delete: (...args) => cloud.delete(...args),
    listV2: (query) => {
      if (denyListing) throw new Error('Injected OSS listing failure');
      return cloud.listV2(query);
    },
  };
  const artifactStore = new OSSArtifactStore({
    region: 'oss-cn-shanghai', bucket: BUCKET,
    accessKeyId: credential.accessKeyId, accessKeySecret: credential.accessKeySecret,
    endpoint: 'https://oss-cn-shanghai.aliyuncs.com', client: sdkBoundary,
  });
  const created: Array<{ id: string; prefix: string }> = [];
  class ObservedClient extends E2BSandboxClient {
    override async create(options: SandboxCreateOptions = {}): Promise<SandboxHandle> {
      const result = await super.create(options);
      const volumes = JSON.parse(options.metadata?.['e2b.agents.kruise.io/csi-volume-config'] ?? 'null');
      created.push({ id: result.id, prefix: `${volumes[0].subPath}/` });
      record('sandbox-created', { sandboxId: result.id, prefix: `${volumes[0].subPath}/` });
      return result;
    }
  }
  const client = new ObservedClient({
    domain: DOMAIN, apiKey: credential.apiKey, defaultTemplate: 'code-interpreter-vfscli',
    verifyWorkspaceProbe: async (target, name, content) => {
      assert.equal(target.bucket, BUCKET);
      await artifactStore.verifyWorkspaceProbe(target.prefix, name, content);
    },
  });
  const stores = createMemoryStores();
  const manager = new DefaultSandboxManager({ sandboxClient: client, provisionSources: { s3: new S3ProvisionSource(stores.skillArtifactStore) }, defaults: { lifetimeSeconds: 1800 } });
  const hub = new InProcessEventStreamHub();
  const turnStreamStore = new InMemoryTurnStreamStore();
  const interruptReady = deferred();
  const parallelReady = deferred();
  const parallelRelease = deferred();
  let parallelCount = 0;
  let adapterRuns = 0;
  const binary = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1cAAAAASUVORK5CYII=', 'base64');
  function answer(text: string): SessionEvent {
    return { id: randomUUID(), timestamp: new Date().toISOString(), type: 'agent.message', content: [{ type: 'text', text }] };
  }
  const adapter: Adapter = {
    async *run(input: AdapterInput): AsyncIterable<SessionEvent> {
      adapterRuns++;
      const executor = input.toolExecutor;
      assert.ok(executor, 'Host must inject its actual ToolExecutor');
      const content = input.message.content.find(block => block.type === 'text');
      assert.ok(content?.type === 'text');
      const mode = content.text;
      if (mode === 'edit') {
        assert.equal(await executor.readFile('上传.txt'), 'from-browser');
        record('adapter-upload-read-passed');
        await executor.writeFile('上传.txt', 'from-browser; edited-in-sandbox');
        record('adapter-upload-edit-passed');
        await shell(executor, `from pathlib import Path;import base64,os;p=Path('.');assert str(p.resolve()).startswith('/run/csi/mount-root/oss/');assert os.environ['HOME']=='/home/user';(p/'生成 图片.png').write_bytes(base64.b64decode('${binary.toString('base64')}'));(p/'shell-created.txt').write_text('created-by-shell');print('OMA_PROBE_OK')`);
        record('adapter-shell-create-passed');
        const listed = await executor.list('.');
        const listedPaths = listed.map(entry => entry.path);
        assert.ok(listedPaths.includes('上传.txt'));
        assert.ok(listedPaths.includes('生成 图片.png'));
        assert.ok(listedPaths.includes('shell-created.txt'));
        record('tool-executor-list-traverses-workspace-symlink', { paths: listedPaths });
        const skillPath = input.agent.skillDescriptors?.[0]?.path;
        assert.equal(skillPath, '/skills/probe-skill/SKILL.md');
        assert.deepEqual(input.agent.skillPaths, ['/skills/probe-skill']);
        assert.equal(await executor.readFile(skillPath), '# Probe Skill\nversion one');
        yield answer(`Uploaded file edited; shell-created files and projected Skill read successfully at ${skillPath}. Files: ${listedPaths.join(', ')}`);
      } else if (mode.startsWith('parallel-')) {
        await executor.writeFile(`${mode}.txt`, mode);
        parallelCount++;
        if (parallelCount === 2) parallelReady.resolve();
        await parallelRelease.promise;
        yield answer(mode);
      } else if (mode === 'interrupt') {
        await executor.writeFile('saved-before-interrupt.txt', 'saved-before-interrupt');
        yield answer('Durable partial answer before Interrupt.');
        for await (const chunk of executor.exec(['python3', '-c', "import time;print('OMA_WAITING_FOR_INTERRUPT',flush=True);time.sleep(120)"], { signal: input.signal, timeoutSeconds: 180 })) {
          if (chunk.text.includes('OMA_WAITING_FOR_INTERRUPT')) interruptReady.resolve();
        }
      } else if (mode === 'finish-with-storage-failure') {
        await executor.writeFile('saved-before-check-failure.txt', 'saved-before-check-failure');
        yield answer('Answer completed before storage verification failed.');
        denyProbeReads = true;
      } else if (mode === 'fail-after-save') {
        await executor.writeFile('saved-before-adapter-failure.txt', 'saved-before-adapter-failure');
        yield answer('Saved answer before an injected Adapter failure.');
        throw new Error('Injected deterministic Adapter failure');
      } else if (mode === 'read-after-rebuild') {
        assert.equal(await executor.readFile('上传.txt'), 'from-browser; edited-in-sandbox');
        yield answer('Persistent upload read after Sandbox rebuild.');
      } else if (mode === 'skill-refresh') {
        const skillPath = input.agent.skillDescriptors?.[0]?.path;
        assert.ok(skillPath);
        assert.equal(await executor.readFile(skillPath), '# Probe Skill\nversion two');
        yield answer('Updated Skill projection is readable outside Workspace.');
      } else {
        await executor.readFile('上传.txt');
        yield answer('Read succeeded.');
      }
    },
  };
  const router = new SessionRouter({
    ...stores, eventStreamHub: hub, turnStreamStore, resolveAdapter: () => adapter,
    sandboxManager: manager,
    workspaceMount: { bucket: BUCKET, agentName: 'agentry-workspace', pvName: 'agentry-workspace-oss', credentialProviderName: 'agentry-oss-rw' },
    onDrainError: () => record('unexpected-router-drain-error'),
  });
  process.env.AUTH_DISABLED = 'false';
  process.env.INVITE_CODE = randomUUID();
  process.env.AUTH_JWT_SECRET = randomUUID();
  const app = createApp({ ...stores, artifactStore, eventStreamHub: hub, turnStreamStore, sessionRouter: router });
  const sessions: Array<Session & { token: string }> = [];
  const cleanupPrefixes = new Set<string>();
  const headers = (token: string) => ({ authorization: `Bearer ${token}` });
  const json = (path: string, body: unknown, token?: string, method = 'POST') => app.request(path, { method, headers: { 'content-type': 'application/json', ...(token ? headers(token) : {}) }, body: JSON.stringify(body) });
  async function login(username: string) {
    const password = randomUUID();
    assert.equal((await json('/auth/register', { username, password, inviteCode: process.env.INVITE_CODE })).status, 200);
    const response = await json('/auth/login', { username, password });
    assert.equal(response.status, 200);
    return (await response.json()).token as string;
  }
  async function createSession(token: string, agentId: string, targetWorkspace = workspaceId) {
    const response = await json('/v1/sessions', { agent: agentId, workspace_id: targetWorkspace }, token);
    assert.equal(response.status, 201);
    const session = { ...await response.json(), token } as Session & { token: string };
    assert.ok(session.workspaceId.startsWith(`probe_app_${testId}`));
    cleanupPrefixes.add(workspaceObjectPrefix(session.tenantId, session.workspaceId));
    sessions.push(session);
    return session;
  }
  const base = (session: Session) => `/v1/sessions/${session.id}/workspace`;
  const eventsFor = async (session: Session) => (await stores.eventLogStore.getEvents(session.id, { limit: 1000 })).data;
  async function send(session: Session & { token: string }, mode: string) {
    const response = await json(`/v1/sessions/${session.id}/events`, { events: [{ type: 'user.message', data: { content: [{ type: 'text', text: mode }] } }] }, session.token);
    assert.equal(response.status, 202);
  }
  async function turn(session: Session & { token: string }, mode: string) {
    const previous = (await eventsFor(session)).at(-1)?.seq ?? 0;
    await send(session, mode);
    assert.ok(await router.waitForIdle(240000), 'Application Turn did not settle');
    const next = (await eventsFor(session)).filter(event => event.seq > previous);
    assert.ok(next.some(event => event.type === 'session.turn_completed'), 'Turn did not record completion');
    return next;
  }
  async function getText(session: Session & { token: string }, path: string) {
    const response = await app.request(`${base(session)}/files/${encodeURIComponent(path)}`, { headers: headers(session.token) });
    assert.equal(response.status, 200);
    return response.text();
  }
  try {
    record('starting', { reportPath });
    const alice = await login(`alice_${testId.slice(0, 12)}`);
    const bob = await login(`bob_${testId.slice(0, 12)}`);
    const agentResponse = await json('/v1/agents', { name: 'Isolated OSS acceptance', runtime: 'mock', model: 'deterministic-probe', system: 'Deterministic test Adapter', sandbox: { enabled: true, image: 'code-interpreter-vfscli' } }, alice);
    assert.equal(agentResponse.status, 201);
    const agent = await agentResponse.json();
    const a = await createSession(alice, agent.id);
    const b = await createSession(alice, agent.id);
    const sibling = await createSession(alice, agent.id, `${workspaceId}_other`);
    const skill = await stores.skillStore.create({ tenantId: a.tenantId, name: 'probe-skill', description: 'Isolated projection probe', ownerType: 'agent', ownerId: agent.id });
    await stores.skillArtifactStore.put(a.tenantId, skill.id, 'SKILL.md', '# Probe Skill\nversion one');
    await stores.agentStore.update(agent.id, { skills: [skill.id] });
    const form = new FormData(); form.append('path', '上传.txt'); form.append('file', new File(['from-browser'], '上传.txt', { type: 'text/plain' }));
    assert.equal((await app.request(`${base(a)}/files/upload`, { method: 'POST', headers: headers(alice), body: form })).status, 200);
    const editEvents = await turn(a, 'edit');
    record('initial-turn-observed', { types: editEvents.map(event => event.type), errorCodes: editEvents.filter(event => event.type === 'session.error').map(event => (event.data as any).error?.code) });
    assert.equal(editEvents.filter(event => event.type === 'session.error').length, 0);
    assert.equal(await getText(a, '上传.txt'), 'from-browser; edited-in-sandbox');
    assert.equal(await getText(a, 'shell-created.txt'), 'created-by-shell');
    const initialSandboxId = created[0]!.id;
    const listing = await app.request(`${base(a)}/files`, { headers: headers(alice) });
    const paths = (await listing.json()).data.map((file: { path: string }) => file.path);
    assert.ok(paths.includes('生成 图片.png'));
    assert.ok(paths.every((path: string) => !path.startsWith('.oma-workspace-checks') && !path.startsWith('skills/')));
    for (const suffix of ['', '?download=1']) {
      const response = await app.request(`${base(a)}/files/${encodeURIComponent('生成 图片.png')}${suffix}`, { headers: headers(alice) });
      assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), binary);
      if (suffix) assert.ok(response.headers.get('content-disposition')?.includes("filename*=UTF-8''"));
    }
    const signed = await app.request(`${base(a)}/preview-url?path=${encodeURIComponent('生成 图片.png')}`, { headers: headers(alice) });
    assert.equal(signed.status, 200); const signedBody = await signed.json();
    assert.equal(new URL(signedBody.url).hostname, 'agentry.oss-cn-shanghai.aliyuncs.com');
    const publicMedia = await fetch(signedBody.url);
    if (publicMedia.status === 200) {
      assert.equal(publicMedia.headers.get('content-type'), 'image/png');
      assert.deepEqual(Buffer.from(await publicMedia.arrayBuffer()), binary);
      record('public-signed-get-passed');
    } else {
      failedChecks.push('public-signed-get');
      record('public-signed-get-failed', { status: publicMedia.status });
    }
    record('authenticated-upload-turn-preview-download-and-skill-passed');

    assert.equal((await app.request(`${base(a)}/files`)).status, 401);
    assert.equal((await app.request(`${base(a)}/files`, { headers: headers(bob) })).status, 404);
    assert.deepEqual((await (await app.request(`${base(sibling)}/files`, { headers: headers(alice) })).json()).data, []);
    for (const path of ['../other/evil.txt', '/etc/passwd', '.oma-workspace-checks/evil']) assert.equal((await json(`${base(a)}/files/content`, { path, content: 'must-not-write' }, alice, 'PUT')).status, 400);
    record('unauthenticated-cross-tenant-cross-workspace-and-path-rejection-passed');

    await Promise.all([send(a, 'parallel-a'), send(b, 'parallel-b')]);
    await bounded(parallelReady.promise, 'Concurrent Sessions did not reach their independent writes');
    assert.equal((await json(`${base(a)}/files/content`, { path: 'locked.txt', content: 'rejected' }, alice, 'PUT')).status, 423);
    parallelRelease.resolve(); assert.ok(await router.waitForIdle(240000));
    assert.equal(await getText(a, 'parallel-a.txt'), 'parallel-a');
    assert.equal(await getText(a, 'parallel-b.txt'), 'parallel-b');
    record('concurrent-sessions-and-existing-423-gate-passed');

    await client.destroy(initialSandboxId);
    const rebuildEvents = await turn(a, 'read-after-rebuild');
    assert.equal(rebuildEvents.filter(event => event.type === 'session.error').length, 0);
    assert.ok(created.length >= 3);
    record('application-sandbox-rebuild-persistence-passed');

    await stores.skillArtifactStore.put(a.tenantId, skill.id, 'SKILL.md', '# Probe Skill\nversion two');
    const skillEvents = await turn(a, 'skill-refresh');
    assert.equal(skillEvents.filter(event => event.type === 'session.error').length, 0);
    record('skill-reprojection-on-existing-session-passed');

    const beforeFailureRuns = adapterRuns;
    const failureEvents = await turn(a, 'finish-with-storage-failure');
    assert.equal(adapterRuns, beforeFailureRuns + 1);
    assert.ok(failureEvents.some(event => event.type === 'agent.message'));
    assert.ok(failureEvents.some(event => event.type === 'session.error' && (event.data as any).error?.code === 'workspace_storage_error'));
    denyProbeReads = false;
    assert.equal(await getText(a, 'saved-before-check-failure.txt'), 'saved-before-check-failure');
    denyListing = true;
    const unavailable = await app.request(`${base(a)}/files`, { headers: headers(alice) });
    assert.equal(unavailable.status, 503); const failureBody = await unavailable.json();
    assert.equal(failureBody.code, 'workspace_storage_error'); assert.equal(failureBody.data, undefined);
    denyListing = false; assert.equal(adapterRuns, beforeFailureRuns + 1);
    record('completed-answer-and-saved-file-preserved-after-check-or-refresh-failure');

    denyProbeReads = true;
    const blockedRuns = adapterRuns;
    const blocked = await turn(a, 'blocked-before-adapter');
    assert.equal(adapterRuns, blockedRuns); assert.ok(blocked.some(event => event.type === 'session.error'));
    denyProbeReads = false;
    const recovered = await turn(a, 'read-after-rebuild');
    assert.equal(recovered.filter(event => event.type === 'session.error').length, 0);
    record('pre-execution-storage-failure-rejected-and-explicit-retry-recovered');

    const failedTurn = await turn(a, 'fail-after-save');
    assert.ok(failedTurn.some(event => event.type === 'session.error'));
    assert.equal(await getText(a, 'saved-before-adapter-failure.txt'), 'saved-before-adapter-failure');
    await send(a, 'interrupt'); await bounded(interruptReady.promise, 'Interrupt probe did not save');
    const interrupted = await json(`/v1/sessions/${a.id}/events`, { events: [{ type: 'user.interrupt', data: {} }] }, alice);
    assert.equal(interrupted.status, 202); assert.equal((await interrupted.json()).interrupted, true);
    assert.ok(await router.waitForIdle(60000));
    assert.ok((await eventsFor(a)).some(event => event.type === 'session.turn_aborted'));
    assert.equal(await getText(a, 'saved-before-interrupt.txt'), 'saved-before-interrupt');
    record('adapter-failure-and-interrupt-preserve-completed-writes');

    assert.equal((await app.request(`/v1/sessions/${a.id}`, { method: 'DELETE', headers: headers(alice) })).status, 200);
    assert.equal(await getText(b, 'saved-before-interrupt.txt'), 'saved-before-interrupt');
    assert.equal(await getText(b, '上传.txt'), 'from-browser; edited-in-sandbox');
    assert.equal((await json(`${base(b)}/files/rename`, { from: 'shell-created.txt', to: 'renamed.txt' }, alice)).status, 200);
    assert.equal(await getText(b, 'renamed.txt'), 'created-by-shell');
    assert.equal((await app.request(`${base(b)}/files/content?path=renamed.txt`, { method: 'DELETE', headers: headers(alice) })).status, 200);
    record('session-deletion-retains-workspace-and-host-rename-delete-passed');
    assert.deepEqual(failedChecks, [], 'One or more application checks failed');
    report.passed = true;
    record('application-acceptance-passed', { adapterRuns });
  } finally {
    denyProbeReads = false; denyListing = false; parallelRelease.resolve();
    for (const session of sessions) {
      try { await stores.sessionStore.terminate(session.id); await router.terminateSession(session.id); }
      catch { record('session-cleanup-failed', { sessionId: session.id }); process.exitCode = 1; }
    }
    await router.waitForIdle(60000);
    for (const { id } of created) {
      try { await client.destroy(id); record('sandbox-cleaned', { sandboxId: id }); }
      catch { record('sandbox-cleanup-failed', { sandboxId: id }); process.exitCode = 1; }
    }
    for (const prefix of cleanupPrefixes) {
      assert.ok(prefix.split('/')[1]?.startsWith(`probe_app_${testId}`));
      try {
        execFileSync('aliyun', ['ossutil', 'rm', `oss://${BUCKET}/${prefix}`, '--recursive', '--force', '--profile', 'welltop', '--region', 'cn-shanghai', '--endpoint', 'https://oss-cn-shanghai.aliyuncs.com'], { stdio: ['ignore', 'pipe', 'pipe'] });
        const left = await cloud.listV2({ prefix, 'max-keys': 1 }); assert.equal((left.objects ?? []).length, 0);
        record('prefix-cleaned', { prefix });
      } catch { record('prefix-cleanup-failed', { prefix }); process.exitCode = 1; }
    }
  }
}
try { await main(); }
catch (error) { report.passed = false; record('failed', { errorType: error instanceof Error ? error.name : 'unknown', location: error instanceof Error ? error.stack?.split('\n').find(line => line.trimStart().startsWith('at ') && line.includes('verify-application')) : undefined }); process.exitCode = 1; }
finally { report.finishedAt = new Date().toISOString(); writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); }
