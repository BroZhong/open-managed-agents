// Opt-in application + real E2B/OSS acceptance. PostgreSQL MUST be disposable local infrastructure.
// Run with the API package's tsx; init -> resume -> rebuild -> cleanup, one phase at a time.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createPgPool, createPgStores, PgSandboxLifecycleStore, OSSArtifactStore, type SandboxActivity } from '../../server/packages/store/src/index.js';
import { DefaultSandboxManager, E2BSandboxClient, type EnvSpec } from '../../server/packages/sandbox/src/index.js';
import { workspaceConfigFromEnv } from '../../server/packages/api/src/lib/workspace-config.js';
const require = createRequire(new URL('../../server/packages/sandbox/package.json', import.meta.url));
const { Sandbox, SandboxNotFoundError } = require('e2b');
const [phase, file] = process.argv.slice(2);
assert(file && ['init', 'resume', 'rebuild', 'cleanup'].includes(phase));
const pgUrl = new URL(process.env.PG_TEST_URL!);
assert(['127.0.0.1', 'localhost'].includes(pgUrl.hostname) && pgUrl.pathname === '/oma_local_native', 'Use the dedicated local test database');
const marker = 'oma.dev/native-integration';
const evidence = phase === 'init' ? {
  runId: `native-${randomUUID()}`, schema: `native_${randomUUID().replaceAll('-', '')}`,
  ids: [] as string[], observations: [] as unknown[], tenant: 'native-integration', workspace: `ws-${randomUUID()}`,
} : JSON.parse(readFileSync(file, 'utf8'));
assert.match(evidence.schema, /^native_[a-f0-9]{32}$/);
assert.match(evidence.runId, /^native-[a-f0-9-]{36}$/);
if (phase === 'init') writeFileSync(file, JSON.stringify(evidence, null, 2), { flag: 'wx', mode: 0o600 });
const save = () => writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
const record = (data: object) => { evidence.observations.push({ at: new Date().toISOString(), phase, ...data }); save(); console.log(JSON.stringify(data)); };
const kubeconfig = `${homedir()}/.kube/agent-platform-config`;
const kube = (...args: string[]) => JSON.parse(execFileSync('kubectl', ['--kubeconfig', kubeconfig, '--request-timeout=20s', ...args], { encoding: 'utf8', timeout: 25000, stdio: ['ignore', 'pipe', 'pipe'] }));
const pool = createPgPool({ connectionString: pgUrl.href, schema: evidence.schema });
try {
  const env = kube('-n', 'oma-infra', 'exec', 'deployment/oma-runner', '--', 'node', '-e', "process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(WORKSPACE_OSS_|E2B_|SANDBOX_)/.test(key)))))");
  const config = workspaceConfigFromEnv(env);
  if (!evidence.platform) {
    evidence.sdkVersion = JSON.parse(readFileSync(new URL('../../server/packages/sandbox/node_modules/e2b/package.json', import.meta.url), 'utf8')).version;
    evidence.platform = kube('-n', 'sandbox-system', 'get', 'pods', '-o', 'json').items
      .flatMap((pod: any) => pod.status?.containerStatuses ?? [])
      .filter((container: any) => /ack-sandbox-(manager|gateway)/.test(container.image))
      .map(({ name, image, imageID }: any) => ({ name, image, imageID }));
    save();
  }
  const sdk = { apiKey: config.sandbox.apiKey, domain: config.sandbox.domain, requestTimeoutMs: 185000 };
  const artifacts = new OSSArtifactStore({ ...config.oss, endpoint: config.oss.publicEndpoint });
  const owned = () => kube('-n', 'sandbox-system', 'get', 'sandboxes', '-o', 'json').items
    .filter((item: any) => item.metadata.annotations?.[marker] === evidence.runId)
    .map((item: any) => ({ id: `sandbox-system--${item.metadata.name}`, uid: item.metadata.uid }));
  if (phase === 'cleanup') {
    for (const item of owned()) {
      assert(owned().some((fresh: any) => fresh.id === item.id && fresh.uid === item.uid));
      await Sandbox.kill(item.id, sdk);
    }
    if (evidence.snapshotId) {
      await Sandbox.deleteSnapshot(evidence.snapshotId, sdk);
      const paginator = Sandbox.listSnapshots({ ...sdk, sandboxId: evidence.ids[0] });
      const snapshots: Array<{ snapshotId: string }> = [];
      for (let page = 0; paginator.hasNext && page < 20; page++) snapshots.push(...await paginator.nextItems());
      assert(!paginator.hasNext, 'Snapshot listing is incomplete');
      assert(!snapshots.some(item => item.snapshotId === evidence.snapshotId), 'Snapshot deletion is still pending');
    }
    assert.equal(owned().length, 0);
    for (const id of evidence.ids) await assert.rejects(Sandbox.getInfo(id, sdk), SandboxNotFoundError);
    await artifacts.delete(evidence.tenant, evidence.workspace, 'saved.txt');
    assert.equal(await artifacts.get(evidence.tenant, evidence.workspace, 'saved.txt'), null);
    await pool.query(`DROP SCHEMA IF EXISTS "${evidence.schema}" CASCADE`);
    record({ cleanupConfirmed: true, resourceIds: evidence.ids, snapshotRemoved: Boolean(evidence.snapshotId), workspaceRemoved: true, schemaRemoved: true });
    evidence.cleanupConfirmed = true; save();
  } else {
    const stores = await createPgStores(pool, { ensureSchema: phase === 'init', schema: evidence.schema });
    if (phase === 'init') await pool.query(readFileSync(new URL('../migrations/0020_native_sandbox_lifecycle.sql', import.meta.url), 'utf8').replaceAll('oma.', `${evidence.schema}.`));
    const lifecycle = new PgSandboxLifecycleStore(pool);
    await lifecycle.assertReady();
    let mountChecks = 0;
    let connects = 0;
    const client = new E2BSandboxClient({ ...config.sandbox,
      verifyWorkspaceProbe: async (target, name, content) => { mountChecks++; await artifacts.verifyWorkspaceProbe(target.prefix, name, content); },
      connectSandbox: async (id, options) => { connects++; return Sandbox.connect(id, options); },
      createSandbox: async (template, options) => {
        assert.equal(options.timeoutMs, 86400000);
        assert.deepEqual(options.lifecycle, { onTimeout: 'pause', autoResume: false });
        assert.equal(options.metadata?.['e2b.agents.kruise.io/reserve-paused-sandbox-duration'], '24h');
        const start = Date.now();
        // Accelerate ONLY the fixture's retention; application running/idle requests remain 24h/30m.
        const sandbox = await Sandbox.create(template, { ...options, metadata: { ...options.metadata, [marker]: evidence.runId,
          'e2b.agents.kruise.io/reserve-paused-sandbox-duration': '100s' } });
        evidence.ids.push(sandbox.sandboxId);
        record({ created: sandbox.sandboxId, template, elapsedMs: Date.now() - start, productionPolicyVerified: true, testRetention: '100s' });
        return sandbox;
      },
    });
    const manager = new DefaultSandboxManager({ sandboxClient: client, lifecycle });
    const spec: EnvSpec = { tenantId: evidence.tenant, workspaceId: evidence.workspace,
      workspaceMount: { ...config.mount, prefix: `${evidence.tenant}/${evidence.workspace}/` },
      // Every create claims from the Runner's Warm Pool with its image (ADR-0024); a
      // rebuild claims anew rather than from the snapshot, which no create can name.
      image: config.sandboxImage };
    const open = (sessionId: string) => manager.open(spec, { id: evidence.root,
      withLock: work => stores.delegationStore.withBindingLock(evidence.root, work),
      canExecute: async () => (await stores.sessionStore.getById(sessionId))?.status !== 'terminated',
    });
    const begin = async (sessionId: string): Promise<SandboxActivity> => {
      await stores.pendingEventStore.enqueue(sessionId, { type: sessionId === evidence.root ? 'user.message' : 'delegation_input', data: {}, sessionThreadId: 'sthr_primary' });
      const claim = (await stores.pendingEventStore.claim(sessionId, 'integration', 600000))!;
      const activity = { bindingId: evidence.root, sessionId, fence: { eventId: claim.event.id, ownerId: claim.ownerId, generation: claim.generation } };
      await manager.beginActivity(activity); return activity;
    };
    const finish = async (activity: SandboxActivity) => { await stores.pendingEventStore.ack(activity.sessionId, activity.fence.eventId, activity.fence); await manager.finishActivity(activity); };
    const currentId = () => stores.delegationStore.withBindingLock(evidence.root, async id => ({ sandboxId: id, value: id! }));
    const assertDeadline = async (seconds: number) => {
      const info = await Sandbox.getInfo(await currentId(), sdk);
      const remainingSeconds = (info.endAt.getTime() - Date.now()) / 1000;
      assert(remainingSeconds > seconds - 15 && remainingSeconds <= seconds + 2);
      record({ runningDeadlineSeconds: seconds, observedRemainingSeconds: Math.round(remainingSeconds) });
    };
    if (phase === 'init') {
      const agent = await stores.agentStore.create({ tenantId: evidence.tenant, name: evidence.runId, model: 'integration', runtime: 'pi', system: '' });
      const root = await stores.sessionStore.create({ tenantId: evidence.tenant, agentId: agent.id, agent, workspaceId: evidence.workspace });
      evidence.root = root.id;
      const child = await stores.sessionStore.create({ tenantId: evidence.tenant, agentId: agent.id, agent, workspaceId: evidence.workspace,
        delegation: { parentSessionId: root.id, parentTurnId: 'integration', parentToolUseId: 'child', sandboxSessionId: root.id } });
      evidence.child = child.id; save();
      const session = open(root.id);
      await session.prepare(); assert.equal(evidence.ids.length, 0);
      const first = await begin(root.id);
      await session.writeFile('saved.txt', evidence.runId);
      assert.equal(await session.readFile('saved.txt'), evidence.runId);
      assert.equal(mountChecks, 1); assert.equal(connects, 0);
      await finish(first); await assertDeadline(1800);
      const second = await begin(root.id);
      await session.prepare(); await assertDeadline(86400);
      assert.equal(await session.readFile('saved.txt'), evidence.runId);
      assert.equal(mountChecks, 2); assert.equal(connects, 1);
      const childUse = await begin(child.id);
      await finish(second); await assertDeadline(86400); // shared queued input still protects
      const childSession = open(child.id);
      await childSession.prepare();
      assert.equal(await childSession.readFile('saved.txt'), evidence.runId);
      await finish(childUse); await assertDeadline(1800);
      const id = await currentId();
      const snapshot = await Sandbox.createSnapshot(id, { ...sdk, headers: { 'x-e2b-kruise-snapshot-keep-running': 'true', 'x-e2b-kruise-snapshot-ttl': '10m' } });
      evidence.snapshotId = snapshot.snapshotId; save();
      await client.setTimeout(id, 20); // shortened test-only pause observation
      record({ lazyChat: true, reusedAcrossTurns: evidence.ids.length === 1, sharedQueueProtected: true, mountChecks, connects, snapshotId: evidence.snapshotId, pauseInSeconds: 20 });
    } else {
      const previous = await currentId();
      if (phase === 'resume') assert.equal((await Sandbox.getInfo(previous, sdk)).state, 'paused');
      else await assert.rejects(Sandbox.getInfo(previous, sdk), SandboxNotFoundError);
      const use = await begin(evidence.root);
      const session = open(evidence.root);
      await session.prepare();
      if (phase === 'rebuild') { assert.equal(await currentId(), null); assert.equal(evidence.ids.length, 1); }
      assert.equal(await session.readFile('saved.txt'), evidence.runId);
      assert.equal(Buffer.from((await artifacts.get(evidence.tenant, evidence.workspace, 'saved.txt'))!.body).toString(), evidence.runId);
      if (phase === 'resume') {
        assert.equal(await currentId(), previous);
        await finish(use); await assertDeadline(1800);
        await client.setTimeout(previous, 20);
        record({ restoredSameId: previous, workspacePreserved: true, pauseInSeconds: 20 });
      } else {
        assert.notEqual(await currentId(), previous);
        const childUse = await begin(evidence.child);
        const id = await currentId();
        await stores.sessionStore.terminate(evidence.root);
        await session.dispose();
        assert.equal(await currentId(), id); // Child remains a legitimate user.
        const child = open(evidence.child); await child.prepare();
        await finish(childUse);
        await stores.sessionStore.terminate(evidence.child);
        const before = connects;
        await child.dispose();
        assert.equal(connects, before); // No resume just to delete.
        assert.equal(await currentId(), null);
        record({ rebuilt: id, workspacePreserved: true, sharedTerminationProtected: true, directReleaseConfirmed: true });
      }
    }
  }
} catch (error) {
  record({ failed: true, errorType: error instanceof Error ? error.name : 'unknown', ...(error instanceof assert.AssertionError ? { assertion: error.message } : {}) });
  process.exitCode = 1;
} finally { await pool.end(); }
