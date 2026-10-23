// #261 spike (parent #259): can test Sandboxes pull, verify and install
// immutable per-Skill zip bundles straight from OSS, 200 at once, before the
// Runner implementation (#265) is written? The script plays the Runner: it
// signs short-lived GET URLs against the OSS *internal* endpoint, passes them
// on stdin to skill-bundle-spike/install.sh running as root in each Sandbox,
// and then checks bytes, modes and the /skills switch from the Agent's user.
//
// Test-only by construction: E2B/OSS settings come from oma-test, Skills are
// read (read-only) from schema oma_test / bucket workspace-test, Sandboxes come
// only from the test SandboxSet and carry a probe annotation, bundles live
// under an isolated OSS prefix. Sandboxes, OSS objects and local staging are
// removed in finally (also on SIGINT); leftovers self-destruct after 30 min.
//
//   server/packages/api/node_modules/.bin/tsx deploy/scripts/verify-skill-bundle-install.mts \
//     <evidence.json> --font <path/to/LiberationSans-Regular.ttf> [--waves 1,10,200]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import dns from 'node:dns';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const here = new URL('./skill-bundle-spike/', import.meta.url);
const sandboxRequire = createRequire(new URL('../../server/packages/sandbox/package.json', import.meta.url));
const storeRequire = createRequire(new URL('../../server/packages/store/package.json', import.meta.url));
const { Sandbox } = sandboxRequire('e2b');
const OSS = storeRequire('ali-oss');

const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const evidencePath = args[0];
const fontPath = option('--font');
const waves = (option('--waves') ?? '1,10,200').split(',').map(Number);
assert(evidencePath && !evidencePath.startsWith('--') && fontPath, 'usage: <evidence.json> --font <ttf> [--waves 1,10,200]');
assert(waves[0] === 1 && waves.every(n => Number.isInteger(n) && n >= 1 && n <= 200), 'waves must start with 1 and stay <= 200');

const TEMPLATE = 'oma-scale-test-20261021';
const MARKER = 'oma.dev/probe';
const TEST_AGENT = 'agent_tdpcn95CKCCQzEAa5SBGz';
const REGION = 'oss-cn-shanghai';
const BUCKET = 'agentry';
const INTERNAL_HOST = `${REGION}-internal.aliyuncs.com`;
const URL_TTL_SECONDS = 600;
const SANDBOX_TIMEOUT_MS = 30 * 60_000;
// Production Sandboxes get HTTP(S)_PROXY from the base Secret, and its
// NO_PROXY does not cover *.aliyuncs.com. The spike sets the same names to a
// closed local port: a request that fails to bypass the proxy breaks instead of
// reaching the production proxy.
const DUMMY_PROXY = 'http://127.0.0.1:9';
const NO_PROXY = 'localhost,127.0.0.1,::1,.svc,.cluster.local';
const PROXY_ENV = { HTTPS_PROXY: DUMMY_PROXY, HTTP_PROXY: DUMMY_PROXY, https_proxy: DUMMY_PROXY, http_proxy: DUMMY_PROXY, NO_PROXY, no_proxy: NO_PROXY };
const INSTALL_SH = readFileSync(new URL('install.sh', here), 'utf8');
const INSPECT_PY = readFileSync(new URL('inspect.py', here), 'utf8');
const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const runId = `skill-bundle-spike-${stamp}`;
const prefix = `__oma/skills-spike-${stamp}`;

const kubeconfig = `${homedir()}/.kube/agent-platform-config`;
const kubectl = (argv: string[], timeout = 60_000) => execFileSync('kubectl', ['--kubeconfig', kubeconfig, ...argv],
  { encoding: 'utf8', maxBuffer: 512 << 20, timeout, stdio: ['ignore', 'pipe', 'pipe'] });
const kubeJson = (...argv: string[]) => JSON.parse(kubectl(['--request-timeout=30s', ...argv, '-o', 'json']));
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const shq = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const round = (value: number) => Math.round(value * 10) / 10;
const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1))];
const stats = (values: number[]) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { n: 0 };
  return { n: sorted.length, min: round(sorted[0]), p5: round(percentile(sorted, 5)), p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)), max: round(sorted.at(-1)!), mean: round(sorted.reduce((a, b) => a + b, 0) / sorted.length) };
};
const countBy = (values: string[]) => values.reduce<Record<string, number>>((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {});
async function mapLimit<T, R>(items: T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await work(items[i], i); }
  }));
  return out;
}

// ─── evidence: never credentials, signed URLs or Skill content ────────────────
let secrets: string[] = [];
const OUTPUT_MARKERS = ['x-oss-', 'aliyuncs', 'OSS4-HMAC'];
const scrub = (text: string) => secrets.reduce((t, s) => t.split(s).join('***'), text).replace(/https?:\/\/\S+/g, '<url>');
const causes = (error: any) => { const codes: string[] = []; for (let e = error?.cause; e && codes.length < 3; e = e.cause) codes.push(e.code ?? e.name); return codes; };
const safeError = (error: any) => `${error?.name ?? 'Error'}: ${scrub(String(error?.message ?? error)).slice(0, 160)}${causes(error).length ? ` (${causes(error).join(' <- ')})` : ''}`;
const evidence: any = { issue: 261, parent: 259, runId, template: TEMPLATE, ossPrefix: `${prefix}/`, startedAt: new Date().toISOString(), steps: [] };
// Short objects (e.g. one Sandbox row) stay on one line; the rest is indented.
const pretty = (value: unknown, indent = ''): string => {
  const flat = JSON.stringify(value);
  if (value === null || typeof value !== 'object' || flat.length <= 360) return flat;
  const inner = `${indent} `;
  const items = Array.isArray(value) ? value.map(v => inner + pretty(v, inner))
    : Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => `${inner}${JSON.stringify(k)}: ${pretty(v, inner)}`);
  return Array.isArray(value) ? `[\n${items.join(',\n')}\n${indent}]` : `{\n${items.join(',\n')}\n${indent}}`;
};
const save = () => {
  const text = `${pretty(evidence)}\n`;
  for (const value of [...secrets, 'x-oss-signature', 'x-oss-credential']) assert(!text.includes(value), 'evidence would leak a credential or signed URL');
  writeFileSync(evidencePath, text, { mode: 0o600 });
};
const step = (name: string, data: object) => {
  evidence.steps.push({ at: new Date().toISOString(), step: name, ...data });
  save();
  console.log(`[${new Date().toISOString()}] ${name} ${JSON.stringify(data).slice(0, 600)}`);
};

// ─── preconditions and configuration (test environment only) ─────────────────
const sandboxSet = kubeJson('-n', 'sandbox-system', 'get', 'sandboxset', TEMPLATE);
assert.equal(sandboxSet.spec.template.metadata.annotations?.['oma.dev/test-only'], 'true', 'not the test-only SandboxSet');
const envNames = ['E2B_DOMAIN', 'E2B_API_KEY', 'WORKSPACE_OSS_REGION', 'WORKSPACE_OSS_BUCKET', 'WORKSPACE_OSS_ACCESS_KEY_ID', 'WORKSPACE_OSS_ACCESS_KEY_SECRET', 'PG_SCHEMA'];
const env = JSON.parse(kubectl(['-n', 'oma-test', 'exec', 'deployment/oma-runner', '--', 'node', '-e',
  `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(envNames)}.map((n) => [n, process.env[n] ?? '']))))`]));
assert(env.PG_SCHEMA === 'oma_test' && env.WORKSPACE_OSS_BUCKET === BUCKET && env.WORKSPACE_OSS_REGION === REGION, 'not the oma-test configuration');
secrets = [env.E2B_API_KEY, env.WORKSPACE_OSS_ACCESS_KEY_ID, env.WORKSPACE_OSS_ACCESS_KEY_SECRET].filter(v => v.length >= 8);
assert.equal(secrets.length, 3);
const LEAK_MARKERS = [...OUTPUT_MARKERS, ...secrets];
const sdk = { apiKey: env.E2B_API_KEY, domain: env.E2B_DOMAIN, requestTimeoutMs: 185_000 };
// Laptop-only shim. From outside the cluster the SDK reaches every Sandbox at
// its own <port>-<id>.<domain> host, and this laptop's resolver serialises
// lookups of distinct names (200 took ~22 s), which exceeded the connect
// timeout in a first 200 attempt. In-cluster the Runner uses one service URL
// (E2B_SANDBOX_URL), so it never resolves per-Sandbox names. Every such host
// is a CNAME of the gateway ALB, so one cached lookup serves all of them;
// TLS SNI and the Host header still carry the real name.
const [apiCname, sandboxCname] = await Promise.all([`api.${env.E2B_DOMAIN}`, `49983-probe.${env.E2B_DOMAIN}`].map(h => dns.promises.resolveCname(h)));
assert.deepEqual(sandboxCname, apiCname, 'Sandbox hosts must share the gateway ALB');
const systemLookup = dns.lookup;
let gatewayAddresses: { at: number; value: Promise<dns.LookupAddress[]> } | undefined;
(dns as any).lookup = function lookup(hostname: string, options: any, callback?: any) {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (typeof options === 'number') options = { family: options };
  if (!hostname.endsWith(`.${env.E2B_DOMAIN}`)) return systemLookup.call(dns, hostname, options, callback);
  if (!gatewayAddresses || Date.now() - gatewayAddresses.at > 60_000) {
    gatewayAddresses = { at: Date.now(), value: dns.promises.lookup(`api.${env.E2B_DOMAIN}`, { all: true, family: 4 }) };
  }
  gatewayAddresses.value.then(
    list => (options?.all ? callback(null, list) : callback(null, list[0].address, list[0].family)),
    error => { gatewayAddresses = undefined; callback(error); });
};
const ossBase = { region: REGION, bucket: BUCKET, accessKeyId: env.WORKSPACE_OSS_ACCESS_KEY_ID, accessKeySecret: env.WORKSPACE_OSS_ACCESS_KEY_SECRET, secure: true, authorizationV4: true };
const uploader = new OSS({ ...ossBase, endpoint: `https://${REGION}.aliyuncs.com` }); // this laptop reaches only the public endpoint
const signer = new OSS({ ...ossBase, endpoint: `https://${INTERNAL_HOST}` }); // what the Runner will sign against
evidence.platform = {
  sandboxSet: { name: TEMPLATE, uid: sandboxSet.metadata.uid, warmReplicas: sandboxSet.spec.replicas,
    image: sandboxSet.spec.template.spec.containers[0].image.replace(/^.*@/, '@'), resources: sandboxSet.spec.template.spec.containers[0].resources.limits },
  gateway: kubeJson('-n', 'sandbox-system', 'get', 'pods').items.flatMap((pod: any) => pod.status?.containerStatuses ?? [])
    .filter((c: any) => /ack-sandbox-(manager|gateway)/.test(c.image)).map((c: any) => c.image.replace(/^.*\//, '')),
  e2bSdk: JSON.parse(readFileSync(fileURLToPath(new URL('../../server/packages/sandbox/node_modules/e2b/package.json', import.meta.url)), 'utf8')).version,
  aliOss: JSON.parse(readFileSync(storeRequire.resolve('ali-oss/package.json'), 'utf8')).version,
  e2bDomain: env.E2B_DOMAIN, signedEndpoint: `${BUCKET}.${INTERNAL_HOST}`, urlTtlSeconds: URL_TTL_SECONDS,
};
save();

// ─── Sandboxes, OSS prefix and staging are tracked for cleanup ────────────────
const created = new Map<string, any>();
const work = mkdtempSync(join(tmpdir(), 'oma-skill-spike-'));
let outputLeaks = 0;
const listPrefix = async () => {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await uploader.listV2({ prefix: `${prefix}/`, 'max-keys': 1000, ...(token ? { 'continuation-token': token } : {}) });
    keys.push(...(page.objects ?? []).map((o: any) => o.name));
    token = page.isTruncated ? page.nextContinuationToken : undefined;
  } while (token);
  return keys;
};
const owned = () => kubeJson('-n', 'sandbox-system', 'get', 'sandboxes').items
  .filter((item: any) => item.metadata.annotations?.[MARKER] === runId).map((item: any) => `sandbox-system--${item.metadata.name}`);
// Kill retries: control-plane calls from this laptop occasionally fail with a
// transient `fetch failed`; the probe annotation listing is the final check.
const release = (ids: string[]) => mapLimit(ids, 40, async id => {
  for (let attempt = 1; ; attempt++) {
    try { await Sandbox.kill(id, sdk); created.delete(id); return null; } catch (error) {
      if (attempt === 3) return safeError(error);
      await sleep(1000 * attempt);
    }
  }
});
let cleaning: Promise<void> | undefined;
const cleanup = () => (cleaning ??= (async () => {
  const started = performance.now();
  const result: any = {};
  try {
    const ids = new Set([...created.keys(), ...owned()]);
    result.killErrors = (await release([...ids])).filter(Boolean);
    let remaining = owned();
    for (let i = 0; remaining.length && i < 60; i++) { await sleep(10_000); await release(remaining); remaining = owned(); }
    Object.assign(result, { sandboxesKilled: ids.size, sandboxesRemainingWithProbeAnnotation: remaining.length });
  } catch (error) { result.sandboxError = safeError(error); }
  try {
    const keys = await listPrefix();
    for (let i = 0; i < keys.length; i += 1000) await uploader.deleteMulti(keys.slice(i, i + 1000), { quiet: true });
    Object.assign(result, { ossObjectsDeleted: keys.length, ossObjectsRemaining: (await listPrefix()).length });
  } catch (error) { result.ossError = safeError(error); }
  rmSync(work, { recursive: true, force: true });
  const pool = kubeJson('-n', 'sandbox-system', 'get', 'sandboxset', TEMPLATE).status;
  evidence.cleanup = { ...result, localStagingRemoved: true, warmPoolAfter: `${pool.availableReplicas}/${pool.replicas}`, ms: Math.round(performance.now() - started) };
  evidence.finishedAt = new Date().toISOString();
  save();
  console.log('cleanup', JSON.stringify(evidence.cleanup));
})());
process.once('SIGINT', () => { console.error('SIGINT: cleaning up'); void cleanup().finally(() => process.exit(130)); });

type SourceFile = { path: string; body: Buffer; mode: number };
type Bundle = { name: string; files: SourceFile[]; zip: Buffer; sha256: string; key: string };
type BundleSet = { label: string; bundles: Bundle[]; hash: string; bytes: number; files: number };

async function acquire() {
  const started = performance.now();
  try {
    const sandbox = await Sandbox.create(TEMPLATE, { ...sdk, timeoutMs: SANDBOX_TIMEOUT_MS, envs: PROXY_ENV, metadata: { [MARKER]: runId,
      'e2b.agents.kruise.io/claim-timeout-seconds': '150', 'e2b.agents.kruise.io/wait-ready-timeout-seconds': '150' } });
    created.set(sandbox.sandboxId, sandbox);
    return { sandbox, acquireMs: performance.now() - started };
  } catch (error) { return { error: safeError(error), acquireMs: performance.now() - started }; }
}

async function run(sandbox: any, cmd: string, user = 'user', timeoutMs = 120_000) {
  try {
    const r = await sandbox.commands.run(cmd, { user, timeoutMs });
    return { rc: r.exitCode, stdout: r.stdout as string, stderr: r.stderr as string };
  } catch (error: any) {
    return { rc: error?.exitCode ?? null, stdout: String(error?.stdout ?? ''), stderr: String(error?.stderr ?? ''), error: safeError(error) };
  }
}
const short = (r: { rc: number | null; stdout: string; error?: string }) => ({ rc: r.rc, out: scrub(r.stdout.trim()).slice(0, 800), ...(r.error ? { error: r.error } : {}) });
const inspect = async (sandbox: any, argv: string[], user = 'user') => {
  const r = await run(sandbox, ['python3', '-I', '-c', INSPECT_PY, ...argv].map(shq).join(' '), user, 600_000);
  if (r.rc !== 0) throw new Error(`inspect ${argv[0]} failed rc=${r.rc} ${scrub(r.stderr).slice(0, 200)}`);
  return JSON.parse(r.stdout);
};

async function install(sandbox: any, set: BundleSet, rate = 0) {
  const signStarted = performance.now();
  const lines = [`OMA1 ${set.hash} ${set.bundles.length} ${rate}`];
  for (const bundle of set.bundles) {
    const url: string = await signer.signatureUrlV4('GET', URL_TTL_SECONDS, { headers: {} }, bundle.key);
    assert.equal(new URL(url).host, `${BUCKET}.${INTERNAL_HOST}`);
    lines.push(`${bundle.sha256} ${bundle.zip.length} ${Buffer.from(bundle.name).toString('base64')} ${url}`);
  }
  const signMs = performance.now() - signStarted;
  const started = performance.now();
  let result: { exitCode: number | null; stdout: string; stderr: string; error?: string };
  try {
    const handle = await sandbox.commands.run(INSTALL_SH, { user: 'root', background: true, stdin: true, timeoutMs: 300_000 });
    await sandbox.commands.sendStdin(handle.pid, `${lines.join('\n')}\n`);
    result = await handle.wait();
  } catch (error: any) {
    result = { exitCode: error?.exitCode ?? null, stdout: String(error?.stdout ?? ''), stderr: String(error?.stderr ?? ''), error: safeError(error) };
  }
  const hostMs = performance.now() - started;
  const output = `${result.stdout}\n${result.stderr}`;
  const leaks = LEAK_MARKERS.filter(marker => output.includes(marker)).length;
  outputLeaks += leaks;
  let summary: any = null;
  try { summary = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? ''); } catch { /* reported as unparsable below */ }
  return { hostMs: round(hostMs), signMs: round(signMs), exitCode: result.exitCode, ...(result.error ? { error: result.error } : {}),
    outputLeaks: leaks, stderrBytes: result.stderr.length, summary: summary ?? { ok: false, stage: 'unparsable-output' } };
}

function expectedTree(set: BundleSet) {
  const want = new Map<string, { t: 'd' | 'f'; h?: string; s?: number; m: number }>();
  for (const bundle of set.bundles) {
    want.set(bundle.name, { t: 'd', m: 0o555 });
    for (const file of bundle.files) {
      const parts = file.path.split('/');
      for (let i = 1; i < parts.length; i++) want.set(`${bundle.name}/${parts.slice(0, i).join('/')}`, { t: 'd', m: 0o555 });
      want.set(`${bundle.name}/${file.path}`, { t: 'f', h: sha256(file.body), s: file.body.length, m: file.mode & 0o111 ? 0o555 : 0o444 });
    }
  }
  return want;
}
function compareTree(set: BundleSet, tree: any, asLink = true) {
  const want = expectedTree(set);
  const problems: Record<string, string[]> = { missing: [], extra: [], type: [], bytes: [], mode: [], owner: [] };
  const seen = new Set<string>();
  for (const entry of tree.entries) {
    const path = Buffer.from(entry.p, 'hex').toString('utf8');
    seen.add(path);
    const expected = want.get(path);
    if (!expected) { problems.extra.push(path); continue; }
    if (entry.t !== expected.t) problems.type.push(path);
    if (expected.t === 'f' && (entry.h !== expected.h || entry.s !== expected.s)) problems.bytes.push(path);
    if (entry.m !== expected.m) problems.mode.push(`${path}:${entry.m.toString(8)}`);
    if (entry.u !== 0 || entry.g !== 0) problems.owner.push(path);
  }
  for (const path of want.keys()) if (!seen.has(path)) problems.missing.push(path);
  const versionDir = `/opt/oma/skills/${set.hash}`;
  const denial = Object.entries(tree.denial).filter(([, outcome]) => outcome === 'ALLOWED').map(([op]) => op);
  const rootOk = tree.root.m === 0o555 && tree.root.u === 0 && tree.root.g === 0;
  const linkOk = !asLink || (tree.isLink && tree.target === versionDir);
  const counts = Object.fromEntries(Object.entries(problems).map(([k, v]) => [k, v.length]));
  const ok = Object.values(problems).every(v => v.length === 0) && rootOk && linkOk && denial.length === 0;
  return { ok, files: tree.entries.filter((e: any) => e.t === 'f').length, dirs: tree.entries.filter((e: any) => e.t === 'd').length,
    rootOk, linkOk, readerUid: tree.uid, writesAllowed: denial, denial: tree.denial, problemCounts: counts,
    ...(ok ? {} : { problemSamples: Object.fromEntries(Object.entries(problems).map(([k, v]) => [k, v.slice(0, 5)])) }) };
}
// Server-side view of acquisition: a Sandbox created during the wave is a cold
// start (CR creation -> Ready, 1 s resolution); older ones were warm-pool claims.
const serverAcquisition = (waveStartedAt: number) => {
  const items = kubeJson('-n', 'sandbox-system', 'get', 'sandboxes').items.filter((i: any) => i.metadata.annotations?.[MARKER] === runId);
  const rows = items.map((i: any) => ({ created: Date.parse(i.metadata.creationTimestamp),
    ready: Date.parse(i.status?.conditions?.find((c: any) => c.type === 'Ready' && c.status === 'True')?.lastTransitionTime ?? '') }));
  const cold = rows.filter((r: any) => r.created >= waveStartedAt - 2000);
  return { sandboxes: rows.length, warmPoolClaims: rows.length - cold.length, coldCreateToReadySeconds: stats(cold.map((r: any) => (r.ready - r.created) / 1000)) };
};
const throughput = (bytes: number, ms: number) => (ms > 0 ? Math.round(bytes / (ms / 1000)) : null);
const installRow = (install: any) => ({ ...install,
  downloadBytesPerSecond: install.summary.ok && !install.summary.reused ? throughput(install.summary.bytes, install.summary.ms.download) : null,
  endToEndBytesPerSecond: install.summary.ok && !install.summary.reused ? throughput(install.summary.bytes, install.hostMs) : null });
const installStats = (rows: any[]) => {
  const ok = rows.filter(r => r.summary.ok);
  return { installs: rows.length, succeeded: ok.length, failed: rows.length - ok.length,
    failureStages: countBy(rows.filter(r => !r.summary.ok).map(r => r.error ?? r.summary.stage)),
    ossErrors: ok.reduce((n, r) => n + r.summary.errors, 0), ossBadCodes: countBy(ok.flatMap(r => (r.summary.badCodes || '').split(',').filter(Boolean))),
    downloadAttempts: ok.reduce((n, r) => n + r.summary.attempts, 0), tcpConnects: stats(ok.map(r => r.summary.connects)),
    hostInstallMs: stats(ok.map(r => r.hostMs)), sandboxTotalMs: stats(ok.map(r => r.summary.ms.total)),
    phaseMs: Object.fromEntries(['readStdin', 'lock', 'download', 'verify', 'extract', 'permissions', 'switch'].map(k => [k, stats(ok.map(r => r.summary.ms[k]))])),
    downloadBytesPerSecond: stats(ok.map(r => r.downloadBytesPerSecond)), endToEndBytesPerSecond: stats(ok.map(r => r.endToEndBytesPerSecond)),
    signMs: stats(rows.map(r => r.signMs)), outputLeaks: rows.reduce((n, r) => n + r.outputLeaks, 0) };
};
const logMarkerCount = (argv: string[]) => {
  try {
    const text = kubectl(['-n', 'sandbox-system', 'logs', ...argv], 180_000);
    return { lines: text.split('\n').length - 1, markerHits: ['x-oss-signature', 'x-oss-credential', 'OSS4-HMAC', ...secrets].reduce((n, m) => n + text.split(m).length - 1, 0) };
  } catch (error) { return { error: safeError(error) }; }
};

try {
  // ─── bundles: real Skills (read-only export) + fixture + calibration ────────
  const exportStarted = performance.now();
  const exportOnce = () => {
    const out = kubectl(['-n', 'oma-test', 'exec', 'deployment/oma-runner', '--', 'node', '-e',
      readFileSync(new URL('export-skills.cjs', here), 'utf8'), TEST_AGENT], 300_000).trimEnd();
    const cut = out.lastIndexOf('\n');
    const [bytes, digest] = out.slice(cut + 1).split(' ');
    const text = out.slice(0, cut);
    if (Buffer.byteLength(text) !== Number(bytes) || sha256(text) !== digest) throw new Error('export stream truncated');
    return JSON.parse(text);
  };
  let exported: any;
  for (let attempt = 1; !exported; attempt++) {
    try { exported = exportOnce(); } catch (error) { if (attempt === 3) throw error; console.log(`export attempt ${attempt}: ${safeError(error)}`); }
  }
  const tenantId: string = exported.tenantId;
  // Supabase keeps no file modes; the spike marks shebang scripts executable.
  const real = exported.skills.map((skill: any) => ({ name: skill.name, files: skill.files.map((f: any) => {
    const body = Buffer.from(f.b64, 'base64');
    return { path: f.path, body, mode: body.subarray(0, 2).toString('latin1') === '#!' ? 0o755 : 0o644 };
  }) }));
  assert.equal(new Set(real.map((s: any) => s.name)).size, real.length);
  const font = readFileSync(fontPath);
  const tables = font.readUInt32BE(0) === 0x00010000 ? font.readUInt16BE(4) : 0;
  const headTable = Array.from({ length: tables }, (_, i) => 12 + 16 * i).find(o => font.toString('latin1', o, o + 4) === 'head');
  assert(headTable !== undefined && font.readUInt32BE(font.readUInt32BE(headTable + 8) + 12) === 0x5f0f3cf5, '--font must be a valid TrueType file');
  const fixture = { name: 'oma-spike fixture-测试', files: [
    { path: 'SKILL.md', body: Buffer.from('---\nname: oma-spike fixture\ndescription: Install spike fixture.\n---\n'), mode: 0o644 },
    { path: 'fonts/LiberationSans-Regular.ttf', body: font, mode: 0o644 },
    { path: 'bin/run.sh', body: Buffer.from('#!/bin/sh\necho fixture-ok\n'), mode: 0o755 },
    { path: 'bin/not-executable.sh', body: Buffer.from('#!/bin/sh\necho should-not-run\n'), mode: 0o644 },
    { path: 'data/random.bin', body: randomBytes(256 << 10), mode: 0o644 },
    { path: 'data/empty', body: Buffer.alloc(0), mode: 0o644 },
    { path: 'docs/说明 文件.md', body: Buffer.from('UTF-8 name with a space\n'), mode: 0o644 },
    { path: 'deep/a/b/c/d/e/leaf.txt', body: Buffer.from('leaf\n'), mode: 0o600 },
  ] };
  const calibration = { name: 'oma-spike-calibration', files: [{ path: 'blob.bin', body: randomBytes(64 << 20), mode: 0o644 }] };
  const sources = [...real, fixture, calibration];
  execFileSync('python3', ['-I', fileURLToPath(new URL('pack.py', here))], { maxBuffer: 1 << 20, stdio: ['pipe', 'pipe', 'inherit'],
    input: JSON.stringify({ out: work, bundles: sources.map(b => ({ files: b.files.map((f: SourceFile) => ({ path: f.path, mode: f.mode, b64: f.body.toString('base64') })) })) }) });
  const bundles: Bundle[] = sources.map((b, i) => {
    const zip = readFileSync(join(work, `${i}.zip`));
    const digest = sha256(zip);
    return { ...b, zip, sha256: digest, key: `${prefix}/${tenantId}/${digest}.zip` };
  });
  const storedTtf = real.flatMap((s: any) => s.files).filter((f: SourceFile) => /\.(ttf|otf)$/i.test(f.path));
  const makeSet = (label: string, members: Bundle[]): BundleSet => ({ label, bundles: members,
    hash: sha256(members.map(b => `${b.name}\0${b.sha256}\n`).sort().join('')),
    bytes: members.reduce((n, b) => n + b.zip.length, 0), files: members.reduce((n, b) => n + b.files.length, 0) });
  const realBundles = bundles.slice(0, real.length);
  const fixtureBundle = bundles[real.length];
  const calibrationBundle = bundles[real.length + 1];
  const setA = makeSet('A: 19 Skills + fixture', [...realBundles, fixtureBundle]);
  const setB = makeSet('B: A without its first Skill (switch + argv probe)', [...realBundles.slice(1), fixtureBundle]);
  const setC = makeSet('C: A + 64 MiB calibration bundle', [...realBundles, fixtureBundle, calibrationBundle]);
  step('bundles:packed', { exportMs: Math.round(performance.now() - exportStarted), skills: real.length,
    skillFiles: real.reduce((n: number, s: any) => n + s.files.length, 0), skillBytes: real.reduce((n: number, s: any) => n + s.files.reduce((m: number, f: SourceFile) => m + f.body.length, 0), 0),
    executableSkillFiles: real.reduce((n: number, s: any) => n + s.files.filter((f: SourceFile) => f.mode & 0o111).length, 0),
    storedSkillFonts: storedTtf.map((f: SourceFile) => ({ bytes: f.body.length, replacementCharSequences: f.body.toString('latin1').split('\xef\xbf\xbd').length - 1 })),
    fixtureFont: { bytes: font.length, sha256: sha256(font) }, packer: 'python3 zipfile (deflate, Unix external attributes, UTF-8 names)',
    bundles: bundles.map(b => ({ name: b.name, files: b.files.length, rawBytes: b.files.reduce((n, f) => n + f.body.length, 0), zipBytes: b.zip.length, sha256: b.sha256 })),
    sets: [setA, setB, setC].map(s => ({ label: s.label, hash: s.hash, bundles: s.bundles.length, files: s.files, zipBytes: s.bytes })) });

  assert.equal((await listPrefix()).length, 0, 'spike OSS prefix must start empty');
  const uploadStarted = performance.now();
  for (const bundle of bundles) await uploader.put(bundle.key, bundle.zip);
  step('bundles:uploaded', { objects: bundles.length, bytes: bundles.reduce((n, b) => n + b.zip.length, 0), ms: Math.round(performance.now() - uploadStarted),
    keyLayout: `${prefix}/<tenantId>/<sha256>.zip`, listed: (await listPrefix()).length });

  for (const size of waves) {
    const label = `wave${size}`;
    const acquireStarted = performance.now();
    const acquireStartedAt = Date.now();
    const acquired = await Promise.all(Array.from({ length: size }, acquire));
    const ready = acquired.filter(a => a.sandbox);
    const acquireFailures = acquired.filter(a => !a.sandbox).map(a => a.error!);
    step(`${label}:acquired`, { requested: size, acquired: ready.length, failed: acquireFailures.length, failureKinds: countBy(acquireFailures),
      acquireMs: stats(ready.map(a => a.acquireMs)), wallMs: Math.round(performance.now() - acquireStarted), server: serverAcquisition(acquireStartedAt) });
    if (!ready.length) throw new Error(`${label}: no Sandbox acquired`);

    if (size === 1) {
      const sandbox = ready[0].sandbox;
      const id = sandbox.sandboxId;
      const internalUrl = `https://${BUCKET}.${INTERNAL_HOST}/`;
      const stdinProbe = await (async () => {
        const reader = await sandbox.commands.run('read -r -t 10 line; echo "len=${#line} uid=$(id -u)"', { user: 'root', background: true, stdin: true, timeoutMs: 30_000 });
        await sandbox.commands.sendStdin(reader.pid, 'abc def\n');
        const lineRead = (await reader.wait()).stdout.trim();
        const cat = await sandbox.commands.run('cat > /dev/null; echo eof', { background: true, stdin: true, timeoutMs: 30_000 });
        let closeStdin: string;
        try { await sandbox.commands.closeStdin(cat.pid); closeStdin = 'supported'; } catch (error) { closeStdin = safeError(error); }
        await cat.kill();
        return { lineRead, closeStdin };
      })();
      step(`${label}:inventory`, { sandboxId: id, envdVersion: sandbox.commands.envdVersion, stdin: stdinProbe,
        defaultUser: short(await run(sandbox, 'echo "$(id -un) uid=$(id -u) home=$HOME"')),
        rootExec: short(await run(sandbox, 'echo "$(id -un) uid=$(id -u) home=$HOME"', 'root')),
        sudoFallback: short(await run(sandbox, 'sudo -n id -u')),
        os: short(await run(sandbox, '. /etc/os-release; echo "$PRETTY_NAME $(uname -m) $(nproc)cpu"')),
        tools: short(await run(sandbox, 'for t in curl unzip zipinfo python3 sha256sum flock jq base64 find chown chmod mv ln readlink mktemp stat timeout sudo zip bsdtar wget; do printf "%s=%s " "$t" "$(command -v "$t" || echo MISSING)"; done')),
        versions: short(await run(sandbox, 'curl --version | head -1; unzip -v | head -1; python3 --version; flock --version; mv --version | head -1; bash --version | head -1')),
        utf8Locales: short(await run(sandbox, 'locale -a 2>/dev/null | grep -i utf | tr "\\n" " "')),
        proxyEnvUser: short(await run(sandbox, 'env | grep -i "_proxy=" | cut -d= -f1 | sort | tr "\\n" " "; [ "$HTTPS_PROXY" = http://127.0.0.1:9 ] && echo "(dummy proxy active)"')),
        proxyEnvRoot: short(await run(sandbox, 'env | grep -i "_proxy=" | cut -d= -f1 | sort | tr "\\n" " "; [ "$HTTPS_PROXY" = http://127.0.0.1:9 ] && echo "(dummy proxy active)"', 'root')),
        skillsPathBefore: short(await run(sandbox, 'stat -c "%F" /skills 2>&1; ls -ld /opt/oma 2>&1', 'root')),
        internalDns: short(await run(sandbox, 'getent ahostsv4 oss-cn-shanghai-internal.aliyuncs.com | cut -d" " -f1 | sort -u | tr "\\n" " "')),
        withoutNoproxy: short(await run(sandbox, `curl -sS -o /dev/null -w "http=%{http_code}" --max-time 5 ${internalUrl} 2>/dev/null; echo " curl_exit=$?"`)),
        withNoproxy: short(await run(sandbox, `curl --noproxy '*' -sS -o /dev/null -w "http=%{http_code} ip=%{remote_ip}" --max-time 5 ${internalUrl} 2>/dev/null; echo " curl_exit=$?"`)),
        disk: short(await run(sandbox, 'df -h / | tail -1')) });

      // Unzip behaviour on the fixture (pushed by the Host for this probe only).
      await sandbox.files.write('/tmp/oma-fixture.zip', new Uint8Array(fixtureBundle.zip).buffer);
      const probe = await inspect(sandbox, ['unzip', '/tmp/oma-fixture.zip']);
      const wantNames = new Map(fixture.files.map(f => [Buffer.from(f.path).toString('hex'), f.mode]));
      const unzipResults = Object.fromEntries(Object.entries(probe).filter(([k]) => !k.startsWith('zipfile:')).map(([k, v]: [string, any]) => [k, {
        rc: v.rc, utf8NamesIntact: [...wantNames.keys()].every(n => n in v.modes),
        modesPreserved: [...wantNames].every(([n, mode]) => v.modes[n] === mode),
        modes: Object.fromEntries(Object.entries(v.modes).map(([n, m]: [string, any]) => [Buffer.from(n, 'hex').toString('utf8'), m.toString(8)])) }]));
      step(`${label}:unzip-probe`, { results: unzipResults, zipExternalAttrModesIntact: [...wantNames].every(([n, mode]) => probe['zipfile:externalAttrModes'][n] === mode) });

      const first = installRow(await install(sandbox, setA));
      const rawTree = await inspect(sandbox, ['tree', '/skills']);
      const firstTree = compareTree(setA, rawTree);
      const installedHash = (path: string) => rawTree.entries.find((e: any) => Buffer.from(e.p, 'hex').toString('utf8') === path)?.h;
      const binaryChecks = [
        ...fixture.files.filter(f => /\.(ttf|bin)$/.test(f.path)).map(f => ({ bundle: fixture.name, file: f.path, sha256: sha256(f.body) })),
        ...real.flatMap((s: any) => s.files.filter((f: SourceFile) => /\.ttf$/i.test(f.path)).map((f: SourceFile) => ({ bundle: s.name, file: f.path, sha256: sha256(f.body) }))),
      ].map(c => ({ ...c, bytesIdentical: installedHash(`${c.bundle}/${c.file}`) === c.sha256 }));
      const fixtureDir = `/skills/${fixture.name}`;
      const execCheck = short(await run(sandbox, `${shq(`${fixtureDir}/bin/run.sh`)}; echo " rc=$?"; ${shq(`${fixtureDir}/bin/not-executable.sh`)} 2>/dev/null; echo "not-executable rc=$?"`));
      step(`${label}:first-install`, { set: setA.label, install: first, tree: firstTree, binaryChecks, execCheck,
        installedAsRoot: first.summary.ok, readByUid: firstTree.readerUid, budgetMs: Math.max(30_000, setA.bytes / (20e6 / 1000)) });

      const reuse = await install(sandbox, setA);
      step(`${label}:reinstall-same-set`, { install: reuse });

      // argv probe: a rate-limited install keeps curl alive while /proc is sampled.
      const sampler = await sandbox.commands.run(['python3', '-I', '-c', INSPECT_PY, 'sample', '/tmp/oma-sampler.stop', '120'].map(shq).join(' '),
        { user: 'root', background: true, timeoutMs: 180_000 });
      await sleep(500);
      const slow = await install(sandbox, setB, 100_000);
      await run(sandbox, 'touch /tmp/oma-sampler.stop', 'root');
      const samples = JSON.parse((await sampler.wait()).stdout);
      const switched = compareTree(setB, await inspect(sandbox, ['tree', '/skills']));
      const previous = compareTree(setA, await inspect(sandbox, ['tree', `/opt/oma/skills/${setA.hash}`]), false);
      const files = short(await run(sandbox, "grep -rlsI -e 'x-oss-signature' -e 'x-oss-credential' /tmp /var/tmp /root /home/user /opt/oma /var/log /etc 2>/dev/null | wc -l", 'root'));
      step(`${label}:argv-and-switch`, { set: setB.label, rateLimitBytesPerSecondPerTransfer: 100_000, install: slow, procSampler: samples,
        filesContainingSignedUrlMarkers: files, switchedTree: switched, previousVersionIntact: previous });

      const large = installRow(await install(sandbox, setC));
      const largeTree = compareTree(setC, await inspect(sandbox, ['tree', '/skills']));
      step(`${label}:calibration-install`, { set: setC.label, zipBytes: setC.bytes, install: large, tree: { ok: largeTree.ok, files: largeTree.files, problemCounts: largeTree.problemCounts } });

      const pod = id.replace(/^sandbox-system--/, '');
      const containers = kubeJson('-n', 'sandbox-system', 'get', 'pod', pod);
      const names = [...containers.spec.initContainers ?? [], ...containers.spec.containers].map((c: any) => c.name);
      step(`${label}:log-leak-check`, { sandboxPodContainers: Object.fromEntries(names.map((c: string) => [c, logMarkerCount([pod, '-c', c])])),
        gateway: logMarkerCount(['deployment/sandbox-gateway', '--all-containers', '--since=30m']),
        manager: logMarkerCount(['deployment/sandbox-manager', '--all-containers', '--since=30m']) });
    } else {
      const sandboxes = ready.map(a => a.sandbox);
      const installStarted = performance.now();
      const installs = await Promise.all(sandboxes.map(sandbox => install(sandbox, setA).then(installRow)));
      const installWallMs = performance.now() - installStarted;
      const trees = await mapLimit(sandboxes, 40, async sandbox => {
        try { return compareTree(setA, await inspect(sandbox, ['tree', '/skills'])); } catch (error) { return { ok: false, error: safeError(error) } as any; }
      });
      const rows = ready.map((a, i) => {
        const { summary, ...install } = installs[i];
        return { sandbox: a.sandbox.sandboxId.replace(/^sandbox-system--/, ''), acquireMs: Math.round(a.acquireMs), hostMs: Math.round(install.hostMs), ok: summary.ok,
          ...(summary.ok ? { bytes: summary.bytes, attempts: summary.attempts, errors: summary.errors, connects: summary.connects, ms: summary.ms,
            downloadBps: install.downloadBytesPerSecond, endToEndBps: install.endToEndBytesPerSecond } : { stage: install.error ?? summary.stage }),
          ...(install.outputLeaks ? { outputLeaks: install.outputLeaks } : {}),
          treeOk: trees[i].ok, ...(trees[i].ok ? {} : { treeProblems: trees[i].problemCounts ?? trees[i].error }) };
      });
      const totalBytes = installs.filter(r => r.summary.ok).reduce((n, r) => n + r.summary.bytes, 0);
      step(`${label}:first-install`, { set: setA.label, concurrentInstalls: sandboxes.length, installWallMs: Math.round(installWallMs),
        aggregateBytesPerSecond: throughput(totalBytes, installWallMs), ...installStats(installs),
        treesVerified: trees.filter(t => t.ok).length, treeFailures: trees.filter(t => !t.ok).length, rows });
      if (size <= 10) {
        const largeStarted = performance.now();
        const large = await Promise.all(sandboxes.map(sandbox => install(sandbox, setC).then(installRow)));
        const largeWallMs = performance.now() - largeStarted;
        const largeTrees = await mapLimit(sandboxes, 10, async sandbox => compareTree(setC, await inspect(sandbox, ['tree', '/skills'])).ok);
        step(`${label}:calibration-install`, { set: setC.label, zipBytesPerSandbox: setC.bytes, installWallMs: Math.round(largeWallMs),
          aggregateBytesPerSecond: throughput(large.filter(r => r.summary.ok).reduce((n, r) => n + r.summary.bytes, 0), largeWallMs),
          ...installStats(large), treesVerified: largeTrees.filter(Boolean).length });
      }
      if (size === 200 || size === waves.at(-1)) {
        step(`${label}:log-leak-check`, { gateway: logMarkerCount(['deployment/sandbox-gateway', '--all-containers', '--since=30m']),
          manager: logMarkerCount(['deployment/sandbox-manager', '--all-containers', '--since=30m']) });
      }
      const failedInstalls = installs.filter(r => !r.summary.ok).length;
      if (acquireFailures.length > Math.max(1, size * 0.05) || failedInstalls > Math.max(1, size * 0.05)) {
        step(`${label}:distress-stop`, { acquireFailures: acquireFailures.length, failedInstalls });
        break;
      }
    }
    const releaseStarted = performance.now();
    const killErrors = (await release(ready.map(a => a.sandbox.sandboxId))).filter(Boolean);
    step(`${label}:released`, { killed: ready.length - killErrors.length, killErrors, ms: Math.round(performance.now() - releaseStarted) });
  }
  evidence.outputLeaks = outputLeaks;
} catch (error) {
  step('failed', { error: safeError(error) });
  process.exitCode = 1;
} finally {
  await cleanup();
}
