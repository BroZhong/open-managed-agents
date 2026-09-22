// Isolated, resumable gateway probe. Never selects existing user Sandboxes.
// node deploy/scripts/verify-sandbox-lifetime.mjs init|adopt|check|cleanup <evidence.json>
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../../server/packages/sandbox/package.json', import.meta.url));
const { Sandbox } = require('e2b');
const [phase, file] = process.argv.slice(2);
assert(file && ['init', 'adopt', 'check', 'cleanup'].includes(phase), 'Expected init|adopt|check|cleanup and evidence path');
const kubeconfig = process.env.OMA_KUBECONFIG ?? `${homedir()}/.kube/agent-platform-config`;
const kubectl = (...args) => execFileSync('kubectl', ['--kubeconfig', kubeconfig, ...args], { encoding: 'utf8' });
const secret = JSON.parse(kubectl('-n', 'oma-infra', 'get', 'secret', 'oma-secrets', '-o', 'json'));
const apiKey = Buffer.from(secret.data.E2B_API_KEY, 'base64').toString();
const opts = { apiKey, domain: process.env.E2B_DOMAIN ?? 'sandbox.agentry.welltop.tech', requestTimeoutMs: 185000 };
let evidence = phase === 'init' ? { runId: `oma-lifetime-${Date.now()}`, startedAt: new Date().toISOString(), sandboxes: [], observations: [] } : JSON.parse(readFileSync(file, 'utf8'));
// Earlier probe output named total elapsed time hostDisconnectedMs. Observational
// reconnects interrupt that interval, so preserve the value with its exact meaning.
for (const observation of evidence.observations) {
  if (observation.hostDisconnectedMs !== undefined) {
    observation.elapsedSinceProbeStartMs = observation.hostDisconnectedMs;
    delete observation.hostDisconnectedMs;
  }
}
if (!evidence.deployment) {
  evidence.sdkVersion = JSON.parse(readFileSync(new URL('../../server/packages/sandbox/node_modules/e2b/package.json', import.meta.url), 'utf8')).version;
  evidence.deployment = ['sandbox-gateway', 'sandbox-manager'].map(name => {
    const deployment = JSON.parse(kubectl('-n', 'sandbox-system', 'get', 'deployment', name, '-o', 'json'));
    return { name, containers: deployment.spec.template.spec.containers.map(container => ({ name: container.name, image: container.image,
      timeoutArguments: (container.args ?? []).filter(arg => arg.startsWith('--e2b-max-timeout=')) })) };
  });
}
const save = () => writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
const observe = (data) => { evidence.observations.push({ at: new Date().toISOString(), ...data }); save(); console.log(JSON.stringify(data)); };
const resource = (id) => {
  const all = JSON.parse(kubectl('-n', 'sandbox-system', 'get', 'sandboxes', '-o', 'json')).items;
  const found = all.find(x => x.metadata.annotations?.['oma.dev/lifetime-probe'] === evidence.runId && (`sandbox-system--${x.metadata.name}` === id || x.metadata.name === id));
  return found ? { name: found.metadata.name, uid: found.metadata.uid, podUid: found.status.podInfo?.podUID, createdAt: found.metadata.creationTimestamp, shutdownTime: found.spec.shutdownTime ?? null, phase: found.status.phase } : null;
};
if (phase === 'init') {
  save();
  for (const [kind, timeoutMs, never] of [['never', 60000, true], ['zero', 0, false], ['finite', 60000, false]]) {
    const sb = await Sandbox.create('auto-story-v2', { ...opts, timeoutMs, metadata: { 'oma.dev/lifetime-probe': evidence.runId, ...(never ? { 'e2b.agents.kruise.io/never-timeout': 'true' } : {}) } });
    const item = { kind, id: sb.sandboxId, createdAt: new Date().toISOString() };
    evidence.sandboxes.push(item); save();
    const command = await sb.commands.run("sh -c 'date +%s > /tmp/oma-lifetime-start; sleep 3700; date +%s > /tmp/oma-lifetime-done'", { background: true, timeoutMs: 0 });
    item.pid = command.pid; await command.disconnect();
    observe({ kind, id: item.id, resource: resource(item.id), pid: item.pid });
  }
  // Exiting this process deliberately leaves no Host renewal heartbeat.
} else if (phase === 'adopt') {
  assert(!evidence.sandboxes.some(x => x.kind === 'adopted'), 'Adoption probe already exists');
  const sb = await Sandbox.create('auto-story-v2', { ...opts, timeoutMs: 120000, metadata: { 'oma.dev/lifetime-probe': evidence.runId } });
  const item = { kind: 'adopted', id: sb.sandboxId, createdAt: new Date().toISOString() };
  evidence.sandboxes.push(item); save();
  const command = await sb.commands.run("sh -c 'date +%s > /tmp/oma-lifetime-start; sleep 3700; date +%s > /tmp/oma-lifetime-done'", { background: true, timeoutMs: 0 });
  item.pid = command.pid; await command.disconnect();
  const before = resource(item.id);
  assert(before?.shutdownTime, 'Expected finite expiry before adoption');
  // UID test prevents a same-name replacement from being patched accidentally.
  kubectl('-n', 'sandbox-system', 'patch', 'sandbox', before.name, '--type=json', '-p', JSON.stringify([
    { op: 'test', path: '/metadata/uid', value: before.uid },
    { op: 'remove', path: '/spec/shutdownTime' },
  ]));
  const after = resource(item.id);
  assert(after?.uid === before.uid && after.shutdownTime === null);
  const reconnected = await Sandbox.connect(item.id, opts);
  assert(resource(item.id)?.shutdownTime === null, 'Reconnect reintroduced expiry');
  const live = await reconnected.commands.run(`kill -0 ${item.pid} && echo RUNNING`, { timeoutMs: 10000 });
  let commandTimedOut = false;
  try { await reconnected.commands.run('sleep 10', { timeoutMs: 100 }); }
  catch { commandTimedOut = true; }
  observe({ kind: item.kind, before, after, stdout: live.stdout, commandTimedOut, sandboxSurvivesCommandTimeout: await reconnected.isRunning() });
} else if (phase === 'check') {
  for (const item of evidence.sandboxes) {
    const current = resource(item.id);
    observe({ kind: item.kind, id: item.id, resource: current, elapsedSinceProbeStartMs: Date.now() - Date.parse(evidence.startedAt) });
    if (!['never', 'adopted'].includes(item.kind)) continue;
    assert(current && current.shutdownTime === null, 'Never-timeout must have no shutdownTime');
    const sb = await Sandbox.connect(item.id, opts);
    const result = await sb.commands.run(`sh -c 'kill -0 ${item.pid} 2>/dev/null && echo RUNNING; printf "START="; cat /tmp/oma-lifetime-start; printf "DONE="; cat /tmp/oma-lifetime-done 2>/dev/null || true'`, { timeoutMs: 10000 });
    const start = /^START=(\d+)/m.exec(result.stdout)?.[1];
    const done = /^DONE=(\d+)/m.exec(result.stdout)?.[1];
    observe({ kind: item.kind, stdout: result.stdout, commandDurationSeconds: start && done ? Number(done) - Number(start) : null, afterReconnect: resource(item.id) });
  }
} else {
  for (const item of evidence.sandboxes) {
    // Authorize deletion by the unique probe annotation, never by template.
    if (!resource(item.id)) continue;
    await Sandbox.kill(item.id, opts);
    for (let attempt = 0; attempt < 30 && resource(item.id); attempt++) await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal(resource(item.id), null, 'Probe resource still exists after explicit deletion');
    observe({ kind: item.kind, explicitlyKilled: true, resourceRemoved: true });
  }
}
