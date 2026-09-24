// Controlled real gateway + PostgreSQL acceptance, isolated from OMA user state.
// PG_TEST_URL must point at a disposable database; never production OMA PG.
// pnpm --dir server --filter @oma-server/api exec tsx ../../../deploy/scripts/verify-sandbox-idle.mts init|check|cleanup /absolute/evidence.json
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { createPgPool, createPgStores, PgSandboxLifecycleStore, OSSArtifactStore, type SandboxActivity } from '../../server/packages/store/src/index.js';
import { E2BSandboxClient, DefaultSandboxManager, type EnvSpec } from '../../server/packages/sandbox/src/index.js';
import { workspaceConfigFromEnv } from '../../server/packages/api/src/lib/workspace-config.js';

const [phase, output] = process.argv.slice(2);
assert(['init', 'check', 'cleanup'].includes(phase) && output);
assert(process.env.PG_TEST_URL?.startsWith('postgres://postgres@127.0.0.1:'), 'Use an isolated PostgreSQL port-forward');
const require = createRequire(new URL('../../server/packages/sandbox/package.json', import.meta.url));
const { Sandbox } = require('e2b');
const env = JSON.parse(execFileSync('kubectl', ['--kubeconfig', `${homedir()}/.kube/agent-platform-config`, '-n', 'oma-infra', 'exec', 'deployment/oma-server', '--', 'node', '-e', "process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(WORKSPACE_OSS_|E2B_|SANDBOX_)/.test(key)))))"], { encoding: 'utf8' }));
const config = workspaceConfigFromEnv(env);
config.oss.endpoint = config.oss.publicEndpoint;
const artifactStore = new OSSArtifactStore(config.oss);
type Case = { root: string; activity: SandboxActivity; child?: string; originalId?: string; pid?: number };
type Evidence = { runId: string; schema: string; tenant: string; workspace: string; startedAt: string; cases: Record<string, Case>; observations: unknown[] };
const evidence: Evidence = phase === 'init' ? {
  runId: `oma-idle-${Date.now()}`, schema: `oma_idle_${Date.now()}`, tenant: 'lifecycle-verification', workspace: `workspace-${Date.now()}`,
  startedAt: new Date().toISOString(), cases: {}, observations: [],
} : JSON.parse(await readFile(output, 'utf8'));
assert(/^oma_idle_\d+$/.test(evidence.schema));
const pool = createPgPool({ connectionString: process.env.PG_TEST_URL, schema: evidence.schema });
const stores = await createPgStores(pool, { ensureSchema: phase === 'init', schema: evidence.schema });
const lifecycle = new PgSandboxLifecycleStore(pool);
const client = new E2BSandboxClient({ ...config.sandbox, verifyWorkspaceProbe: (target, name, content) => artifactStore.verifyWorkspaceProbe(target.prefix, name, content) });
const manager = new DefaultSandboxManager({ sandboxClient: client, provisionSources: {}, lifecycle });
const spec: EnvSpec = { tenantId: evidence.tenant, workspaceId: evidence.workspace, workspaceMount: { ...config.mount, prefix: `${evidence.tenant}/${evidence.workspace}/` } };
const open = (root: string) => manager.open(spec, { id: root, withLock: work => stores.delegationStore.withEnvironmentLock(root, work) });
const save = () => writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
const observe = async (data: unknown) => { evidence.observations.push({ at: new Date().toISOString(), data }); await save(); console.log(JSON.stringify(data)); };
const idFor = async (root: string) => (await pool.query('SELECT sandbox_id FROM delegation_environments WHERE id = $1', [root])).rows[0]?.sandbox_id;
const finish = async (activity: SandboxActivity) => {
  await stores.pendingEventStore.clear(activity.sessionId);
  await lifecycle.finish(activity);
};
const begin = async (sessionId: string, bindingId: string, enqueue: boolean) => {
  if (enqueue) await stores.pendingEventStore.enqueue(sessionId, { type: 'user.message', data: {}, sessionThreadId: 'sthr_primary' });
  const claim = (await stores.pendingEventStore.claim(sessionId, 'verification-restarted-host', 60000))!;
  assert(claim);
  const activity = { bindingId, sessionId, fence: { eventId: claim.event.id, ownerId: claim.ownerId, generation: claim.generation } };
  await manager.beginActivity(activity);
  return activity;
};
try {
  if (phase === 'init') {
    await save();
    const migration = await readFile(new URL('../migrations/0014_sandbox_lifecycle.sql', import.meta.url), 'utf8');
    await pool.query(migration.replaceAll('oma.', `${evidence.schema}.`));
    await lifecycle.assertReady();
    const agent = await stores.agentStore.create({ tenantId: evidence.tenant, name: evidence.runId, runtime: 'pi', model: 'verification', system: '' });
    for (const name of ['idle', 'queued', 'unknown']) {
      const parent = await stores.sessionStore.create({ tenantId: evidence.tenant, agentId: agent.id, agent, workspaceId: evidence.workspace });
      await stores.pendingEventStore.enqueue(parent.id, { type: 'user.message', data: {}, sessionThreadId: 'sthr_primary' });
      const claim = (await stores.pendingEventStore.claim(parent.id, 'verification-host', 60000))!;
      const activity = { bindingId: parent.id, sessionId: parent.id, fence: { eventId: claim.event.id, ownerId: claim.ownerId, generation: claim.generation } };
      const item: Case = { root: parent.id, activity }; evidence.cases[name] = item; await save();
      await manager.beginActivity(activity);
      const sandbox = open(parent.id);
      await sandbox.writeFile(`${name}.txt`, `saved-${name}`);
      await sandbox.writeFile('/tmp/parent-input', `temporary-${name}`);
      item.originalId = await idFor(parent.id); await save();
      if (name === 'queued') {
        const child = await stores.sessionStore.create({ tenantId: evidence.tenant, agentId: agent.id, agent, workspaceId: evidence.workspace,
          delegation: { parentSessionId: parent.id, parentTurnId: 'turn', parentToolUseId: 'tool', sandboxSessionId: parent.id } });
        item.child = child.id;
        await stores.pendingEventStore.enqueue(child.id, { type: 'delegation_input', data: {}, sessionThreadId: 'sthr_primary' });
      }
      if (name === 'unknown') {
        const sb = await Sandbox.connect(item.originalId, config.sandbox);
        const command = await sb.commands.run("sh -c 'sleep 120; echo REMOTE_EXITED > /tmp/remote-exit-evidence'", { background: true, timeoutMs: 0 });
        item.pid = command.pid; await command.disconnect();
        await stores.pendingEventStore.clear(parent.id);
        // Abrupt Host loss: deliberately retain the unresolved activity token.
      } else await finish(activity);
      await observe({ phase, name, ...item });
    }
    await manager.sweepIdle(); // Starts only the idle case's real 30-minute clock.
    await observe({ idleStartedAt: (await pool.query('SELECT idle_since FROM delegation_environments WHERE id = $1', [evidence.cases.idle.root])).rows[0].idle_since });
  } else if (phase === 'check') {
    const elapsedMs = Date.now() - Date.parse(evidence.startedAt);
    const idle = evidence.cases.idle;
    const idleRow = (await pool.query('SELECT idle_since FROM delegation_environments WHERE id=$1', [idle.root])).rows[0];
    assert(idleRow.idle_since && Date.now() - new Date(idleRow.idle_since).getTime() >= 1800000, 'Wait a full real 30 minutes');
    await manager.sweepIdle();
    assert.equal(await idFor(idle.root), null);
    assert.equal(await idFor(evidence.cases.queued.root), evidence.cases.queued.originalId);
    assert.equal(await idFor(evidence.cases.unknown.root), evidence.cases.unknown.originalId);
    const queued = evidence.cases.queued;
    const childActivity = await begin(queued.child!, queued.root, false);
    const shared = open(queued.root);
    assert.equal(await shared.readFile('/tmp/parent-input'), 'temporary-queued');
    const parentActivity = await begin(queued.root, queued.root, true);
    const parentHandle = open(queued.root);
    let childDone = false;
    const childCommand = (async () => {
      let text = '';
      for await (const chunk of shared.exec(['sh', '-c', 'sleep 5; cat /tmp/parent-input'], { timeoutSeconds: 0 })) text += chunk.text;
      childDone = true; return text;
    })();
    for await (const _ of parentHandle.exec(['sh', '-c', 'sleep 1'], { timeoutSeconds: 0 })) {}
    await finish(parentActivity);
    assert.equal(childDone, false, 'Expected child still executing after parent settlement');
    await parentHandle.dispose();
    await manager.sweepIdle();
    assert.equal(await idFor(queued.root), queued.originalId);
    assert.equal(await childCommand, 'temporary-queued');
    await finish(childActivity);
    const resumed = await begin(idle.root, idle.root, true);
    const restored = open(idle.root);
    assert.equal(await restored.readFile('idle.txt'), 'saved-idle');
    assert.notEqual(await idFor(idle.root), idle.originalId);
    await assert.rejects(restored.readFile('/tmp/parent-input'));
    await finish(resumed);
    const unknown = evidence.cases.unknown;
    assert.equal((await open(unknown.root).readFile('/tmp/remote-exit-evidence')).trim(), 'REMOTE_EXITED');
    await lifecycle.finish(unknown.activity); // Release only after observing remote exit evidence.
    assert.equal(await lifecycle.claimReclamation(unknown.root), null);
    await observe({ phase, elapsedMs, idleReclaimedAndRebuilt: true, workspacePreserved: true, temporaryFilesDiscarded: true, queuedChildTemporaryInputPreserved: true, concurrentChildSurvivedParentDisposal: true, unknownRetainedUntilExitConfirmed: true });
  } else {
    for (const item of Object.values(evidence.cases)) {
      const id = await idFor(item.root);
      if (id) {
        const info = await Sandbox.getInfo(id, config.sandbox);
        assert.equal(info.metadata['oma.dev/tenant'], evidence.tenant);
        assert.equal(info.metadata['oma.dev/workspace'], evidence.workspace);
        await Sandbox.kill(id, config.sandbox);
      }
    }
    for (const name of ['idle', 'queued', 'unknown']) await artifactStore.delete(evidence.tenant, evidence.workspace, `${name}.txt`);
    await pool.query(`DROP SCHEMA "${evidence.schema}" CASCADE`);
    await observe({ phase, resourcesRemoved: true });
  }
} finally { await pool.end(); }
