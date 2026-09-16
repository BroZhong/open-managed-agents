// Run on stdin inside oma-server, using its installed E2B SDK and credentials.
// Only a short-lived verification sandbox is created; always reclaim it.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire("/app/server/packages/sandbox/package.json");
const { Sandbox } = await import(pathToFileURL(require.resolve("e2b")).href);
const apiRequire = createRequire("/app/server/packages/api/package.json");
const { tsImport } = await import(pathToFileURL(apiRequire.resolve("tsx/esm/api")).href);
const { E2BSandboxClient } = await tsImport(
  "/app/server/packages/sandbox/src/e2b-sandbox-client.ts", import.meta.url,
);
const { sandboxBaseEnvFromKubernetes } = await tsImport(
  "/app/server/packages/api/src/lib/sandbox-base-secret.ts", import.meta.url,
);
const baseEnv = await sandboxBaseEnvFromKubernetes(process.env);
const options = { domain: process.env.E2B_DOMAIN, apiKey: process.env.E2B_API_KEY };
assert(options.domain && options.apiKey, "The Host must configure its E2B endpoint and key");
const template = process.env.SANDBOX_TEMPLATE;
assert.equal(template, "auto-story-v2", "The Host global default must be auto-story-v2");
const marker = `auto-story-live-${Date.now()}`;
const file = "/home/user/workspace/.image-release-verification.txt";
const workspacePrefix = `image-release-verification/${marker}`;
const mountEnv = process.env;
assert(mountEnv.WORKSPACE_OSS_PV_NAME && mountEnv.WORKSPACE_OSS_AGENT_NAME && mountEnv.WORKSPACE_OSS_CREDENTIAL_PROVIDER,
  "The Host must configure its Workspace mount");
const diagnosticTask = process.env.VFS_DIAGNOSTIC_TASK_ID;
assert(!diagnosticTask || /^audio_[a-f0-9-]{36}$/.test(diagnosticTask));
let sandbox;
let handle;
const report = { template, domain: options.domain, checks: [], ok: false };
try {
  // Match the running Host's constructor; omit image on create so this tests
  // its global default selection through the real deployed SandboxClient.
  const client = new E2BSandboxClient({ ...options, defaultTemplate: template });
  handle = await client.create({
    timeoutSeconds: 300,
    env: { ...baseEnv, AUTO_STORY_SMOKE_VALUE: marker },
    metadata: {
      purpose: "auto-story-default-verification",
      "security.agents.kruise.io/agent-name": mountEnv.WORKSPACE_OSS_AGENT_NAME,
      "e2b.agents.kruise.io/csi-volume-config": JSON.stringify([{
        pvName: mountEnv.WORKSPACE_OSS_PV_NAME,
        mountPath: "/home/user/workspace",
        subPath: workspacePrefix,
        attributes: { credentialProviderName: mountEnv.WORKSPACE_OSS_CREDENTIAL_PROVIDER },
      }]),
    },
  });
  sandbox = await Sandbox.connect(handle.id, options);
  report.sandboxId = sandbox.sandboxId;
  assert.match(handle.id, /auto-story-v2/, "The gateway must allocate from the auto-story pool");
  report.checks.push({ name: "gateway_create_server_default", ok: true });

  const env = await sandbox.commands.run("printf '%s' \"$AUTO_STORY_SMOKE_VALUE\"", {
    cwd: "/home/user", timeoutMs: 20_000,
  });
  assert.equal(env.stdout, marker, "Creation-time environment injection failed");
  report.checks.push({ name: "creation_environment", ok: true });

  const mount = await sandbox.commands.run('readlink -f /home/user/workspace', {
    cwd: "/home/user", timeoutMs: 20_000,
  });
  assert.match(mount.stdout.trim(), /^\/run\/csi\/mount-root\/oss\/[a-f0-9]{32}$/);
  report.checks.push({ name: "workspace_csi_mount", ok: true });
  await client.writeFile(handle.id, file, marker);
  assert.equal(await client.readFile(handle.id, file), marker);
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
  const removed = await sandbox.commands.run('test ! -e /usr/local/bin/story-seed', {
    cwd: "/home/user", timeoutMs: 20_000,
  });
  assert.equal(removed.exitCode, 0);
  report.checks.push({ name: "story_seed_launcher_removed", ok: true });

  // Replay an existing failed task; never generate or incur another charge.
  if (diagnosticTask) {
    for (const mode of ["", " --once --wait 20s"]) {
      const replay = await sandbox.commands.run(
        `vfs-cli generate query --task-id ${diagnosticTask} --model seed-audio-1.0 --format json --timeout 30s${mode} 2>&1; true`,
        { cwd: "/home/user", timeoutMs: 40_000 },
      );
      const payload = JSON.parse(replay.stdout);
      assert(payload.error, "Expected the historical task error envelope");
      assert.match(JSON.stringify(payload), /DurationOutOfRange/);
      report.checks.push({ name: mode ? "provider_error_once" : "provider_error_replay", ok: true,
        taskId: diagnosticTask, providerError: "DurationOutOfRange" });
    }
  }
  report.ok = true;
} catch (error) {
  report.error = String(error?.message ?? error).replaceAll(options.apiKey, "[redacted]");
  process.exitCode = 1;
} finally {
  if (handle) {
    try {
      if (sandbox) {
        try { await sandbox.commands.run(`rm -f ${file}`, { cwd: "/home/user", timeoutMs: 20_000 }); }
        finally { await sandbox.kill(); }
      }
      else await Sandbox.kill(handle.id, options);
      report.checks.push({ name: "gateway_reclaim", ok: true });
    } catch (error) {
      report.ok = false;
      process.exitCode = 1;
      report.checks.push({ name: "gateway_reclaim", ok: false, error: String(error?.message ?? error).replaceAll(options.apiKey, "[redacted]") });
    }
  }
  console.log(JSON.stringify(report, null, 2));
}
