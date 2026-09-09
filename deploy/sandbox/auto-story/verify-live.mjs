// Run on stdin inside oma-server, using its installed E2B SDK and credentials.
// Only a short-lived verification sandbox is created; always reclaim it.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire("/app/server/packages/sandbox/package.json");
const { Sandbox } = await import(pathToFileURL(require.resolve("e2b")).href);
const options = { domain: process.env.E2B_DOMAIN, apiKey: process.env.E2B_API_KEY };
assert(options.domain && options.apiKey, "The Host must configure its E2B endpoint and key");
const template = process.env.SANDBOX_TEMPLATE;
assert.equal(template, "auto-story", "The Host global default must be auto-story");
const marker = `auto-story-live-${Date.now()}`;
const file = "/home/user/.auto-story-live-verification.txt";
let sandbox;
const report = { template, domain: options.domain, checks: [], ok: false };
try {
  sandbox = await Sandbox.create(template, {
    ...options,
    timeoutMs: 300_000,
    envs: { AUTO_STORY_SMOKE_VALUE: marker },
    metadata: { purpose: "auto-story-default-verification" },
  });
  report.sandboxId = sandbox.sandboxId;
  report.checks.push({ name: "gateway_create", ok: true });

  const env = await sandbox.commands.run("printf '%s' \"$AUTO_STORY_SMOKE_VALUE\"", {
    cwd: "/home/user", timeoutMs: 20_000,
  });
  assert.equal(env.stdout, marker, "Creation-time environment injection failed");
  report.checks.push({ name: "creation_environment", ok: true });

  await sandbox.files.write(file, marker);
  assert.equal(await sandbox.files.read(file), marker);
  report.checks.push({ name: "gateway_file_write_read", ok: true });

  const reconnected = await Sandbox.connect(sandbox.sandboxId, options);
  assert.equal(await reconnected.files.read(file), marker);
  report.checks.push({ name: "gateway_reconnect", ok: true });

  const result = await reconnected.commands.run(
    'env -i HOME=/home/user PATH=/usr/local/bin:/usr/bin:/bin AUTO_STORY_SMOKE_VALUE="$AUTO_STORY_SMOKE_VALUE" auto-story-smoke --require-env AUTO_STORY_SMOKE_VALUE',
    { cwd: "/home/user", user: "user", timeoutMs: 120_000 },
  );
  assert.equal(result.exitCode, 0, "Image acceptance exited unsuccessfully");
  const acceptance = JSON.parse(result.stdout);
  assert.equal(acceptance.ok, true, "Image acceptance reported a failure");
  report.checks.push({ name: "image_acceptance", ok: true, details: acceptance.checks });
  report.ok = true;
} catch (error) {
  report.error = String(error?.message ?? error).replaceAll(options.apiKey, "[redacted]");
  process.exitCode = 1;
} finally {
  if (sandbox) {
    try {
      await sandbox.kill();
      report.checks.push({ name: "gateway_reclaim", ok: true });
    } catch (error) {
      report.ok = false;
      process.exitCode = 1;
      report.checks.push({ name: "gateway_reclaim", ok: false, error: String(error?.message ?? error).replaceAll(options.apiKey, "[redacted]") });
    }
  }
  console.log(JSON.stringify(report, null, 2));
}
