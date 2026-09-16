#!/usr/bin/env node
/** Isolated Shanghai probe. Does not deploy or touch existing Workspace objects. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Resolve the application's pinned E2B version after `pnpm --dir server install`.
const requireSandbox = createRequire(new URL('../../../server/packages/sandbox/package.json', import.meta.url));
const { Sandbox } = requireSandbox('e2b');
const DOMAIN = 'sandbox.agentry.welltop.tech';
const BUCKET = 'agentry';
const REGION = 'cn-shanghai';
const PROFILE = 'welltop';
const TEMPLATE = 'auto-story-v2';
const WORKSPACE = '/home/user/workspace';
const SOAK_MS = 65 * 60 * 1000;
const testId = randomUUID().replaceAll('-', '');
const prefix = `probe_${testId}/ws_${testId}`;
const reportPath = process.env.OMA_PROBE_REPORT ?? join(tmpdir(), `oma-oss-workspace-${testId}.json`);
const report = { testId, prefix, domain: DOMAIN, startedAt: new Date().toISOString(), events: [] };
const controller = new AbortController();
let sandbox;

function log(event, details = {}) {
  const entry = { at: new Date().toISOString(), event, ...details };
  report.events.push(entry);
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify(entry) + '\n');
}

function loadApiKey() {
  if (process.env.E2B_API_KEY) return process.env.E2B_API_KEY;
  const kubeconfig = process.env.OMA_SHANGHAI_KUBECONFIG;
  if (!kubeconfig) throw new Error('Provide E2B_API_KEY or an explicit OMA_SHANGHAI_KUBECONFIG');
  // Secret contents stay in process memory, never in CLI arguments or the report.
  const secret = JSON.parse(execFileSync('kubectl', [
    '--kubeconfig', kubeconfig, '--request-timeout=20s', '-n', 'oma-infra',
    'get', 'secret', 'oma-secrets', '-o', 'json',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const decode = key => Buffer.from(secret.data[key], 'base64').toString();
  assert.equal(decode('E2B_DOMAIN'), DOMAIN, 'Kubeconfig Secret targets a different E2B domain');
  return decode('E2B_API_KEY');
}

function oss(command, objectPath, extra = []) {
  // All callers use only this run's generated prefix; no user-supplied cleanup path.
  assert.ok(objectPath.startsWith(`${prefix}/`));
  return execFileSync('aliyun', [
    'ossutil', command, `oss://${BUCKET}/${objectPath}`, ...extra,
    '--profile', PROFILE, '--region', REGION,
    '--endpoint', 'https://oss-cn-shanghai.aliyuncs.com',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function attest() {
  const info = await sandbox.getInfo({ requestTimeoutMs: 60000 });
  assert.equal(info.metadata?.['security.agents.kruise.io/agent-name'], 'agentry-workspace');
  const storage = JSON.parse(info.metadata?.['security.agents.kruise.io/storage-auth'] ?? 'null');
  assert.ok(Array.isArray(storage) && storage.some(entry =>
    entry.credentialProviderName === 'agentry-oss-rw' &&
    entry.attributes?.['bucket-name'] === BUCKET &&
    entry.attributes?.['sub-path'] === prefix));
  const result = await sandbox.commands.run(`python3 - <<'PY'
import json, os
p = os.path.realpath('${WORKSPACE}')
assert os.getuid() == 1000 and os.getgid() == 1000
rows = [line.strip() for line in open('/proc/self/mountinfo') if line.split()[4] == p]
assert len(rows) == 1 and ' - fuse.ossfs ' in rows[0], 'Workspace is not an OSS mount'
assert p.startswith('/run/csi/mount-root/oss/'), 'Unexpected CSI mount path'
print(json.dumps({'uid': os.getuid(), 'gid': os.getgid(), 'realpath': p, 'mountinfo': rows}))
PY`, { timeoutMs: 30000 });
  assert.equal(result.exitCode, 0);
  log('mount-attested', { stdout: result.stdout });
}

async function writeAndVerify(phase) {
  const expected = `${phase}-${testId}`;
  const filename = `${phase} 中文 file.txt`;
  const result = await sandbox.commands.run(`python3 - <<'PY'
from pathlib import Path
p = Path('${WORKSPACE}')
p.joinpath('${filename}').write_text('${expected}', encoding='utf-8')
assert p.joinpath('${filename}').read_text(encoding='utf-8') == '${expected}'
p.joinpath('${phase}.bin').write_bytes(bytes(range(256)))
assert p.joinpath('${phase}.bin').read_bytes() == bytes(range(256))
p.joinpath('${phase}-empty.bin').write_bytes(b'')
p.joinpath('${phase}-empty.bin').unlink()
p.joinpath('${phase}.bin').rename(p / '${phase}-renamed.bin')
print('ordinary-user-close-read-rename-delete-ok')
PY`, { timeoutMs: 60000 });
  assert.equal(result.exitCode, 0);
  assert.equal(oss('cat', `${prefix}/${filename}`), expected);
  log('mounted-write-and-host-read-passed', { phase });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => controller.abort(new Error(signal)));
}

try {
  const apiKey = loadApiKey();
  log('starting', { reportPath, template: TEMPLATE, waitMinutes: 65 });
  sandbox = await Sandbox.create(TEMPLATE, {
    domain: DOMAIN, apiKey, timeoutMs: 85 * 60 * 1000, requestTimeoutMs: 185000,
    metadata: {
      'security.agents.kruise.io/agent-name': 'agentry-workspace',
      'e2b.agents.kruise.io/csi-volume-config': JSON.stringify([{
        pvName: 'agentry-workspace-oss', mountPath: WORKSPACE, subPath: prefix,
        attributes: { credentialProviderName: 'agentry-oss-rw' },
      }]),
    },
  });
  report.sandboxId = sandbox.sandboxId;
  log('created', { sandboxId: sandbox.sandboxId });
  await attest();
  await writeAndVerify('initial');
  const firstWriteAt = Date.now();
  report.nextCheckAt = new Date(firstWriteAt + SOAK_MS).toISOString();
  log('soak-started', { nextCheckAt: report.nextCheckAt });
  while (Date.now() - firstWriteAt < SOAK_MS) {
    await delay(Math.min(30000, SOAK_MS - (Date.now() - firstWriteAt)), undefined, { signal: controller.signal });
  }
  await attest();
  await writeAndVerify('after-expiry');
  report.passed = true;
  log('credential-refresh-passed', { elapsedSeconds: Math.floor((Date.now() - firstWriteAt) / 1000) });
} catch (error) {
  report.passed = false;
  // Do not dump SDK/HTTP errors: they may contain request headers or credentials.
  log('failed', { errorType: error?.name ?? 'Error' });
  process.exitCode = 1;
} finally {
  if (sandbox) {
    try {
      await sandbox.kill({ requestTimeoutMs: 60000 });
      log('sandbox-cleaned', { sandboxId: sandbox.sandboxId });
    } catch {
      log('sandbox-cleanup-failed', { sandboxId: sandbox.sandboxId });
      process.exitCode = 1;
    }
  }
  try {
    oss('rm', `${prefix}/`, ['--recursive', '--force']);
    const remaining = execFileSync('aliyun', [
      'ossutil', 'api', 'list-objects-v2', '--bucket', BUCKET, '--prefix', `${prefix}/`,
      '--max-keys', '1', '--profile', PROFILE, '--region', REGION,
      '--endpoint', 'https://oss-cn-shanghai.aliyuncs.com', '--output-format', 'json',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const listing = JSON.parse(remaining);
    assert.equal(Number(listing.KeyCount), 0);
    log('prefix-cleaned', { prefix });
  } catch {
    log('prefix-cleanup-failed', { prefix });
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}
