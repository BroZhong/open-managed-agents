// Isolated #217 capability gate. Kubernetes access is read-only; all mutations
// go through E2B and target resources carrying this run's exact marker.
// See docs/verification/native-sandbox-lifecycle-2026-10-10.md for phases.
// Workspace phases require tsx. Run phases sequentially for each evidence file.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const require = createRequire(new URL('../../server/packages/sandbox/package.json', import.meta.url));
const { Sandbox, SandboxNotFoundError } = require('e2b');
const [phase, file] = process.argv.slice(2);
const phases = ['init', 'init-failure', 'init-cancel', 'init-workspace', 'inspect', 'exercise', 'resume', 'resume-workspace', 'rebuild-workspace', 'delete-command', 'delay-pause', 'network-timeout', 'cleanup'];
assert(file && phases.includes(phase), `Expected ${phases.join('|')} and evidence path`);
const initializing = phase.startsWith('init');
const marker = 'oma.dev/native-lifecycle-verification';
const prefix = 'e2b.agents.kruise.io/';
const kubeconfig = process.env.OMA_KUBECONFIG ?? `${homedir()}/.kube/agent-platform-config`;
const kubectl = (...args) => JSON.parse(execFileSync('kubectl', ['--kubeconfig', kubeconfig, '--request-timeout=20s', ...args, '-o', 'json'], { encoding: 'utf8', timeout: 25_000, stdio: ['ignore', 'pipe', 'pipe'] }));
const evidence = initializing ? {
  runId: `oma-native-${randomUUID()}`, startedAt: new Date().toISOString(),
  requested: { timeoutMs: 90_000, retention: '60s', claimSeconds: 60, readySeconds: 90 },
  sandboxIds: [], observations: [],
} : JSON.parse(readFileSync(file, 'utf8'));
if (phase === 'init-failure' || phase === 'init-cancel') {
  evidence.requested.claimSeconds = 10;
  evidence.requested.readySeconds = 3;
  evidence.requested.failure = 'nonexistent image; no successful readiness possible';
}
if (phase === 'init-workspace') {
  evidence.workspace = { tenant: 'native-lifecycle-verification', id: evidence.runId };
  evidence.requested.timeoutMs = 300_000;
  evidence.requested.claimSeconds = 150;
  evidence.requested.readySeconds = 150;
}
assert.match(evidence.runId, /^oma-native-[a-f0-9-]{36}$/);
const save = () => writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
// Exclusive creation prevents overwriting the only record of an earlier run.
if (initializing) writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
const observe = (data) => {
  evidence.observations.push({ at: new Date().toISOString(), ...data });
  save();
  console.log(JSON.stringify(data));
};
const secret = kubectl('-n', 'oma-infra', 'get', 'secret', 'oma-secrets');
const apiKey = Buffer.from(secret.data.E2B_API_KEY, 'base64').toString();
const opts = { apiKey, domain: process.env.E2B_DOMAIN ?? 'sandbox.agentry.welltop.tech', requestTimeoutMs: 185_000 };
// Never persist SDK errors/metadata wholesale: they can contain credentials.
const errorSummary = (error) => ({ name: error?.name ?? 'UnknownError', type: error?.constructor?.name ?? 'UnknownError', notFound: error instanceof SandboxNotFoundError });
let artifactStore;
let mountMetadata = {};
if (evidence.workspace) {
  // Workspace phases run with tsx so they use the actual repository mount/store
  // contracts, rather than a second implementation of storage authentication.
  const { workspaceConfigFromEnv } = await import('../../server/packages/api/src/lib/workspace-config.ts');
  const { workspaceMountMetadata } = await import('../../server/packages/sandbox/src/workspace-mount.ts');
  const { OSSArtifactStore } = await import('../../server/packages/store/src/oss/artifact-store.ts');
  const env = JSON.parse(execFileSync('kubectl', ['--kubeconfig', kubeconfig, '--request-timeout=20s', '-n', 'oma-infra', 'exec', 'deployment/oma-runner', '--', 'node', '-e', "process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(WORKSPACE_OSS_|E2B_|SANDBOX_)/.test(key)))))"], { encoding: 'utf8', timeout: 25_000, stdio: ['ignore', 'pipe', 'pipe'] }));
  const config = workspaceConfigFromEnv(env);
  artifactStore = new OSSArtifactStore({ ...config.oss, endpoint: config.oss.publicEndpoint });
  assert.equal(evidence.workspace.id, evidence.runId);
  assert.equal(evidence.workspace.tenant, 'native-lifecycle-verification');
  mountMetadata = workspaceMountMetadata({ ...config.mount, prefix: `${evidence.workspace.tenant}/${evidence.workspace.id}/` }, '/home/user/workspace');
}
async function verifySavedFile(sandbox) {
  assert.equal(await sandbox.files.read('/home/user/workspace/saved.txt'), evidence.runId);
  const stored = await artifactStore.get(evidence.workspace.tenant, evidence.workspace.id, 'saved.txt');
  assert.equal(Buffer.from(stored.body).toString(), evidence.runId);
  observe({ action: 'verify-workspace', id: sandbox.sandboxId, sandboxRead: true, exactOssPrefixRead: true });
}
const resources = () => kubectl('-n', 'sandbox-system', 'get', 'sandboxes').items
  .filter(item => item.metadata.annotations?.[marker] === evidence.runId)
  .map(item => ({
    id: `sandbox-system--${item.metadata.name}`, uid: item.metadata.uid,
    createdAt: item.metadata.creationTimestamp, deletionTimestamp: item.metadata.deletionTimestamp ?? null,
    pauseTime: item.spec.pauseTime ?? null, shutdownTime: item.spec.shutdownTime ?? null,
    paused: item.spec.paused ?? false, phase: item.status?.phase ?? null,
    pauseStrategy: item.spec.pauseStrategy ?? null,
    retention: item.metadata.annotations?.['agents.kruise.io/reserve-paused-sandbox-duration'] ?? null,
    conditions: (item.status?.conditions ?? []).map(({ type, status, reason, lastTransitionTime }) => ({ type, status, reason, lastTransitionTime })),
  }));
const checkpoints = () => evidence.snapshotRequested ? kubectl('-n', 'sandbox-system', 'get', 'checkpoints').items
  .filter(item => evidence.sandboxIds.includes(`sandbox-system--${item.spec.sandboxName}`))
  .map(item => ({ name: item.metadata.name, uid: item.metadata.uid, sandboxName: item.spec.sandboxName,
    snapshotId: item.status?.checkpointId ?? null, phase: item.status?.phase ?? null,
    ttlAfterFinished: item.spec.ttlAfterFinished ?? null, completionTime: item.status?.completionTime ?? null })) : [];
async function ownedSnapshots() {
  const sourceId = evidence.snapshotSourceId ?? evidence.sandboxIds[0];
  assert(evidence.sandboxIds.includes(sourceId), 'Snapshot source is not a recorded test Sandbox');
  const paginator = Sandbox.listSnapshots({ ...opts, sandboxId: sourceId, limit: 100 });
  const ids = [];
  for (let page = 0; paginator.hasNext && page < 20; page++) ids.push(...(await paginator.nextItems()).map(item => item.snapshotId));
  assert.equal(paginator.hasNext, false, 'Snapshot listing did not finish');
  return ids;
}
async function inspect() {
  const owned = resources();
  // Include resources whose create response was lost; discover only exact marker.
  for (const item of owned) if (!evidence.sandboxIds.includes(item.id)) evidence.sandboxIds.push(item.id);
  save();
  const infos = [];
  for (const id of evidence.sandboxIds) {
    try {
      const info = await Sandbox.getInfo(id, { ...opts, requestTimeoutMs: 15_000 });
      infos.push({ id, state: info.state, endAt: info.endAt, lifecycle: info.lifecycle ?? null });
    } catch (error) { infos.push({ id, error: errorSummary(error) }); }
  }
  observe({ phase, resources: owned, infos, ...(evidence.snapshotRequested ? { checkpoints: checkpoints() } : {}) });
  return owned;
}

try {
if (initializing) {
  evidence.sdkVersion = JSON.parse(readFileSync(new URL('../../server/packages/sandbox/node_modules/e2b/package.json', import.meta.url))).version;
  evidence.deployment = kubectl('-n', 'sandbox-system', 'get', 'deployments').items
    .filter(item => ['sandbox-manager', 'sandbox-gateway'].includes(item.metadata.name))
    .map(item => ({ name: item.metadata.name, containers: item.spec.template.spec.containers.map(({ name, image }) => ({ name, image })) }));
  evidence.images = kubectl('-n', 'sandbox-system', 'get', 'pods').items
    .flatMap(item => (item.status?.containerStatuses ?? []).map(({ name, image, imageID }) => ({ name, image, imageID })))
    .filter(item => /ack-sandbox-(manager|gateway)/.test(item.image));
  save();
  const start = Date.now();
  try {
    const sandbox = await Sandbox.create('auto-story-v2', {
      ...opts, requestTimeoutMs: ['init-failure', 'init-cancel'].includes(phase) ? 35_000 : opts.requestTimeoutMs, timeoutMs: evidence.requested.timeoutMs,
      ...(phase === 'init-cancel' ? { signal: AbortSignal.timeout(1_200) } : {}),
      lifecycle: { onTimeout: 'pause', autoResume: false },
      metadata: {
        [marker]: evidence.runId,
        ...mountMetadata,
        [`${prefix}reserve-paused-sandbox-duration`]: evidence.requested.retention,
        [`${prefix}claim-timeout-seconds`]: String(evidence.requested.claimSeconds),
        [`${prefix}wait-ready-timeout-seconds`]: String(evidence.requested.readySeconds),
        ...(['init-failure', 'init-cancel'].includes(phase) ? {
          [`${prefix}image`]: `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox:${evidence.runId}-nonexistent`,
          [`${prefix}reserve-failed-sandbox-for`]: '30s',
        } : {}),
      },
    });
    evidence.sandboxIds.push(sandbox.sandboxId);
    observe({ action: 'create', id: sandbox.sandboxId, elapsedMs: Date.now() - start });
    if (phase === 'init-workspace') {
      await sandbox.files.write('/home/user/workspace/saved.txt', evidence.runId);
      await verifySavedFile(sandbox);
      await sandbox.setTimeout(20_000);
    }
  } catch (error) {
    observe({ action: 'create', elapsedMs: Date.now() - start, error: errorSummary(error) });
    process.exitCode = 1;
  }
  await inspect();
  // Exit: no OMA process/controller remains responsible for expiry.
} else if (phase === 'inspect') {
  await inspect();
} else if (phase === 'network-timeout') {
  // A real socket accepts the SDK request but never returns headers. Never send
  // a live credential to the local fault-injection server.
  let received = 0;
  const server = createServer(() => { received++; });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const start = Date.now();
  try {
    await Sandbox.getInfo(evidence.sandboxIds[0], { apiKey: 'fixture-only', apiUrl: `http://127.0.0.1:${server.address().port}`, requestTimeoutMs: 200 });
    assert.fail('Expected request timeout');
  } catch (error) {
    observe({ action: phase, received, elapsedMs: Date.now() - start, error: errorSummary(error) });
    assert.equal(received, 1);
    assert.equal(error instanceof SandboxNotFoundError, false);
    assert.equal(error.name, 'TimeoutError');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
} else if (phase === 'rebuild-workspace') {
  assert(evidence.workspace);
  assert.equal((await inspect()).length, 0, 'Wait for the original resource to be deleted');
  for (const id of evidence.sandboxIds) await assert.rejects(Sandbox.getInfo(id, opts), SandboxNotFoundError);
  const start = Date.now();
  const sandbox = await Sandbox.create('auto-story-v2', { ...opts, timeoutMs: 300_000,
    lifecycle: { onTimeout: 'pause', autoResume: false }, metadata: { ...mountMetadata, [marker]: evidence.runId,
      [`${prefix}reserve-paused-sandbox-duration`]: '60s', [`${prefix}claim-timeout-seconds`]: '150', [`${prefix}wait-ready-timeout-seconds`]: '150' } });
  evidence.sandboxIds.push(sandbox.sandboxId);
  observe({ action: phase, id: sandbox.sandboxId, elapsedMs: Date.now() - start });
  await verifySavedFile(sandbox);
  await inspect();
} else if (['exercise', 'resume', 'resume-workspace', 'delete-command', 'delay-pause'].includes(phase)) {
  const owned = await inspect();
  assert.equal(owned.length, 1, 'Expected exactly one owned test resource');
  const id = owned[0].id;
  const before = await Sandbox.getInfo(id, opts);
  assert.equal(before.state, ['exercise', 'delete-command', 'delay-pause'].includes(phase) ? 'running' : 'paused');
  const start = Date.now();
  const sandbox = await Sandbox.connect(id, { ...opts, timeoutMs: 300_000 });
  observe({ action: 'connect', from: before.state, id: sandbox.sandboxId, elapsedMs: Date.now() - start });
  await inspect();
  if (phase === 'delay-pause') {
    // Only test-local filesystem data and a native platform snapshot. No CR patches.
    await sandbox.commands.run('dd if=/dev/urandom of=/tmp/oma-snapshot-data bs=1048576 count=512 status=none; sync', { timeoutMs: 20_000 });
    evidence.snapshotRequested = true;
    evidence.snapshotSourceId = id;
    save();
    const snapshotResult = sandbox.createSnapshot({ requestTimeoutMs: 30_000, headers: {
      'x-e2b-kruise-snapshot-keep-running': 'true', 'x-e2b-kruise-snapshot-ttl': '60s',
      'x-e2b-kruise-snapshot-persistent-contents': 'filesystem', 'x-e2b-kruise-snapshot-wait-success-seconds': '0',
    } }).then(snapshot => {
      evidence.snapshotId = snapshot.snapshotId;
      observe({ action: phase, snapshotId: snapshot.snapshotId });
    }, error => { observe({ action: 'snapshot', error: errorSummary(error) }); process.exitCode = 1; });
    await sandbox.setTimeout(1_000);
    // Bounded observations, never a resource controller. Caller can stop here;
    // platform deadlines remain responsible for Sandbox and snapshot lifetime.
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1_000));
      const current = await inspect();
      if (!current.length || current[0].conditions.some(condition => condition.type === 'SandboxPaused' && condition.status === 'True')) break;
    }
    await snapshotResult;
  } else if (phase === 'resume-workspace') {
    await verifySavedFile(sandbox);
    await sandbox.setTimeout(20_000);
  } else if (phase === 'delete-command') {
    let stdout = '';
    let issued;
    const started = new Promise(resolve => { issued = resolve; });
    const result = sandbox.commands.run('echo delete-effect >> /tmp/oma-delete-effects; echo ISSUED; sleep 180; echo COMPLETED', {
      timeoutMs: 20_000, onStdout: chunk => { stdout += chunk; if (stdout.includes('ISSUED')) issued(); },
    }).then(value => ({ exitCode: value.exitCode }), error => ({ error: errorSummary(error) }));
    assert.equal(await Promise.race([started.then(() => true), result.then(() => false)]), true, 'Command failed before it started');
    assert(resources().some(item => item.id === id && item.uid === owned[0].uid), 'Ownership changed');
    await Sandbox.kill(id, opts);
    const outcome = await result;
    observe({ action: phase, stdout, result: outcome, replayed: false });
  } else if (phase === 'exercise') {
    // The only business command is issued once. Timeout errors must not replay it.
    await sandbox.setTimeout(20_000);
    await inspect();
    let stdout = '';
    try {
      const result = await sandbox.commands.run('echo effect >> /tmp/oma-native-effects; echo ISSUED; sleep 180; echo COMPLETED', {
        timeoutMs: 40_000, onStdout: chunk => { stdout += chunk; },
      });
      observe({ action: 'command', exitCode: result.exitCode, stdout });
    } catch (error) { observe({ action: 'command', stdout, outcome: 'unconfirmed; may have side effects; not replayed', error: errorSummary(error) }); }
  } else {
    const result = await sandbox.commands.run('printf "TOOL_READY\\n"; if [ -f /tmp/oma-native-effects ]; then wc -l < /tmp/oma-native-effects; else echo EPHEMERAL_FILE_ABSENT; fi', { timeoutMs: 15_000 });
    observe({ action: 'post-resume-tool', exitCode: result.exitCode, stdout: result.stdout });
    await sandbox.setTimeout(20_000);
  }
  await inspect();
} else {
  const owned = await inspect();
  if (evidence.snapshotRequested) {
    // Recover lost responses using the exact test source Sandbox, never an
    // account-wide template list. Include the returned ID for eventual listings.
    const snapshotIds = new Set(await ownedSnapshots());
    if (evidence.snapshotId) snapshotIds.add(evidence.snapshotId);
    for (const snapshotId of snapshotIds) {
      const deleted = await Sandbox.deleteSnapshot(snapshotId, opts);
      observe({ action: 'delete-snapshot', snapshotId, deleted });
    }
    evidence.snapshotCleanupConfirmed = (await ownedSnapshots()).length === 0;
    save();
  }
  for (const item of owned) {
    // Re-read the exact ownership marker and UID before direct kill; never connect.
    assert(resources().some(current => current.id === item.id && current.uid === item.uid), 'Ownership changed; refusing deletion');
    try {
      await Sandbox.kill(item.id, opts);
      observe({ action: 'kill', id: item.id, accepted: true });
    } catch (error) {
      observe({ action: 'kill', id: item.id, error: errorSummary(error) });
      if (!(error instanceof SandboxNotFoundError)) process.exitCode = 1;
    }
  }
  const remaining = await inspect();
  evidence.cleanupConfirmed = remaining.length === 0 && checkpoints().length === 0 && (!evidence.snapshotRequested || evidence.snapshotCleanupConfirmed === true) && evidence.observations.at(-1).infos.every(info => info.error?.notFound === true);
  save();
  if (evidence.cleanupConfirmed && artifactStore) {
    await artifactStore.delete(evidence.workspace.tenant, evidence.workspace.id, 'saved.txt');
    assert.equal(await artifactStore.get(evidence.workspace.tenant, evidence.workspace.id, 'saved.txt'), null);
    evidence.workspaceCleanupConfirmed = true;
    save();
  }
  if (!evidence.cleanupConfirmed) process.exitCode = 1;
}
} catch (error) {
  observe({ action: phase, error: errorSummary(error) });
  process.exitCode = 1;
}
