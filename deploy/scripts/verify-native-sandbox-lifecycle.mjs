// Isolated #217 capability gate. Kubernetes access is read-only; all mutations
// go through E2B and target resources carrying this run's exact marker.
// node deploy/scripts/verify-native-sandbox-lifecycle.mjs init|inspect|exercise|resume|cleanup evidence.json
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const require = createRequire(new URL('../../server/packages/sandbox/package.json', import.meta.url));
const { Sandbox, SandboxNotFoundError } = require('e2b');
const [phase, file] = process.argv.slice(2);
assert(file && ['init', 'init-failure', 'inspect', 'exercise', 'resume', 'cleanup'].includes(phase), 'Expected init|init-failure|inspect|exercise|resume|cleanup and evidence path');
const initializing = phase === 'init' || phase === 'init-failure';
const marker = 'oma.dev/native-lifecycle-verification';
const prefix = 'e2b.agents.kruise.io/';
const kubeconfig = process.env.OMA_KUBECONFIG ?? `${homedir()}/.kube/agent-platform-config`;
const kubectl = (...args) => JSON.parse(execFileSync('kubectl', ['--kubeconfig', kubeconfig, '--request-timeout=20s', ...args, '-o', 'json'], { encoding: 'utf8', timeout: 25_000, stdio: ['ignore', 'pipe', 'pipe'] }));
const evidence = initializing ? {
  runId: `oma-native-${randomUUID()}`, startedAt: new Date().toISOString(),
  requested: { timeoutMs: 90_000, retention: '60s', claimSeconds: 60, readySeconds: 90 },
  sandboxIds: [], observations: [],
} : JSON.parse(readFileSync(file, 'utf8'));
if (phase === 'init-failure') {
  evidence.requested.claimSeconds = 10;
  evidence.requested.readySeconds = 3;
  evidence.requested.failure = 'nonexistent image; no successful readiness possible';
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
const errorSummary = (error) => ({ name: error?.constructor?.name ?? 'UnknownError', notFound: error instanceof SandboxNotFoundError });
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
  observe({ phase, resources: owned, infos });
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
      ...opts, requestTimeoutMs: phase === 'init-failure' ? 35_000 : opts.requestTimeoutMs, timeoutMs: evidence.requested.timeoutMs,
      lifecycle: { onTimeout: 'pause', autoResume: false },
      metadata: {
        [marker]: evidence.runId,
        [`${prefix}reserve-paused-sandbox-duration`]: evidence.requested.retention,
        [`${prefix}claim-timeout-seconds`]: String(evidence.requested.claimSeconds),
        [`${prefix}wait-ready-timeout-seconds`]: String(evidence.requested.readySeconds),
        ...(phase === 'init-failure' ? {
          [`${prefix}image`]: `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox:${evidence.runId}-nonexistent`,
          [`${prefix}reserve-failed-sandbox-for`]: '30s',
        } : {}),
      },
    });
    evidence.sandboxIds.push(sandbox.sandboxId);
    observe({ action: 'create', id: sandbox.sandboxId, elapsedMs: Date.now() - start });
  } catch (error) {
    observe({ action: 'create', elapsedMs: Date.now() - start, error: errorSummary(error) });
    process.exitCode = 1;
  }
  await inspect();
  // Exit: no OMA process/controller remains responsible for expiry.
} else if (phase === 'inspect') {
  await inspect();
} else if (phase === 'exercise' || phase === 'resume') {
  const owned = await inspect();
  assert.equal(owned.length, 1, 'Expected exactly one owned test resource');
  const id = owned[0].id;
  const before = await Sandbox.getInfo(id, opts);
  assert.equal(before.state, phase === 'exercise' ? 'running' : 'paused');
  const start = Date.now();
  const sandbox = await Sandbox.connect(id, { ...opts, timeoutMs: 300_000 });
  observe({ action: 'connect', from: before.state, id: sandbox.sandboxId, elapsedMs: Date.now() - start });
  await inspect();
  if (phase === 'exercise') {
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
  evidence.cleanupConfirmed = remaining.length === 0 && evidence.observations.at(-1).infos.every(info => info.error?.notFound === true);
  save();
  if (!evidence.cleanupConfirmed) process.exitCode = 1;
}
} catch (error) {
  observe({ action: phase, error: errorSummary(error) });
  process.exitCode = 1;
}
