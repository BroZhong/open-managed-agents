import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

// Built-in Environments (ADR-0024): sandbox/environments/<name>/{environment.json,init.sh}.
const root = new URL("../", import.meta.url);
const environmentsDir = new URL("sandbox/environments/", root);
const builtins = readdirSync(environmentsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const dir = new URL(`${entry.name}/`, environmentsDir);
    return {
      dir: entry.name,
      definition: JSON.parse(readFileSync(new URL("environment.json", dir), "utf8")),
      initScript: readFileSync(new URL("init.sh", dir), "utf8"),
    };
  });

const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const sha256 = /^[0-9a-f]{64}$/;
const secretLooking = /(KEY|SECRET|TOKEN|PASSWORD|_AK|_SK)$/;
const SING_BOX = "http://sing-box.oma-infra.svc.cluster.local:7890";

// System-reserved: the Host's fixed Workspace variables always win, so an
// Environment must not declare them.
const workspaceEnvNames = [
  ...readFileSync(new URL("server/packages/sandbox/src/workspace-environment.ts", root), "utf8")
    .match(/export const WORKSPACE_ENV = \{([\s\S]*?)\}/)[1]
    .matchAll(/^\s+([A-Z_][A-Z0-9_]*):/gm),
].map((m) => m[1]);

/** Script lines without comments or blank lines. */
const code = (script) => script.split("\n").filter((line) => line.trim() && !/^\s*#/.test(line));

test("sandbox/environments holds video-production", () => {
  assert.ok(builtins.some((b) => b.dir === "video-production"));
  assert.ok(workspaceEnvNames.includes("HOME") && workspaceEnvNames.includes("MEDIAKIT_OUTPUT_PATH"));
});

test("every built-in Environment has the agreed definition shape", () => {
  const ids = new Set();
  for (const { dir, definition, initScript } of builtins) {
    assert.deepEqual(Object.keys(definition).sort(), ["baseImage", "description", "env", "id", "name"], dir);
    assert.match(definition.id, /^env_[a-z0-9_]+$/, dir);
    assert.ok(!ids.has(definition.id), `duplicate id ${definition.id}`);
    ids.add(definition.id);
    assert.equal(definition.name, dir);
    assert.ok(typeof definition.description === "string" && definition.description.trim(), dir);
    assert.ok(["oma-base", "oma-media"].includes(definition.baseImage), dir);
    assert.ok(Array.isArray(definition.env), dir);

    const names = new Set();
    let bytes = 0;
    for (const entry of definition.env) {
      const where = `${dir}: ${entry.name}`;
      assert.match(entry.name, envName, where);
      assert.ok(!names.has(entry.name), `${where} declared twice`);
      names.add(entry.name);
      assert.ok(!workspaceEnvNames.includes(entry.name), `${where} is system-reserved`);
      if ("value" in entry) {
        assert.deepEqual(Object.keys(entry).sort(), ["name", "value"], where);
        assert.ok(typeof entry.value === "string" && entry.value !== "" && !entry.value.includes("\0"), where);
        assert.doesNotMatch(entry.name, secretLooking, `${where} looks like a secret but has a plain value`);
        bytes += Buffer.byteLength(entry.name) + Buffer.byteLength(entry.value);
      } else {
        assert.deepEqual(Object.keys(entry).sort(), ["name", "secretRef"], where);
        assert.deepEqual(Object.keys(entry.secretRef).sort(), ["key", "source"], where);
        // Built-ins carry only platform secrets, declared one to one by name.
        assert.equal(entry.secretRef.source, "platform", where);
        assert.equal(entry.secretRef.key, entry.name, where);
      }
    }
    assert.ok(bytes <= 32 * 1024, `${dir}: plain values exceed 32 KiB`);

    assert.match(initScript, /^#!\/usr\/bin\/env bash\n/, dir);
    assert.match(initScript, /^set -euo pipefail$/m, dir);
  }
});

test("init scripts download only through a checksum-verifying fetch", () => {
  for (const { dir, initScript } of builtins) {
    const lines = code(initScript);
    const fetchStart = lines.findIndex((line) => /^fetch\(\) \{$/.test(line));
    const fetchBody = fetchStart < 0 ? [] : lines.slice(fetchStart, lines.indexOf("}", fetchStart) + 1);
    const outside = lines.filter((line) => !fetchBody.includes(line));
    assert.ok(!outside.some((line) => /\b(curl|wget)\b/.test(line)), `${dir}: download outside fetch()`);
    if (fetchStart < 0) continue;
    assert.ok(fetchBody.some((line) => /sha256sum -c/.test(line)), `${dir}: fetch() must verify sha256`);

    const assigned = Object.fromEntries(
      lines.flatMap((line) => [...line.matchAll(/^([A-Z0-9_]+)=(\S+)$/g)]).map((m) => [m[1], m[2]]),
    );
    for (const [name, value] of Object.entries(assigned).filter(([n]) => n.endsWith("_URL"))) {
      const base = name.slice(0, -"_URL".length);
      assert.match(value, /^https:\/\//, `${dir}: ${name}`);
      assert.match(assigned[`${base}_SHA256`] ?? "", sha256, `${dir}: ${name} without ${base}_SHA256`);
      assert.match(assigned[`${base}_BINARY_SHA256`] ?? "", sha256, `${dir}: ${name} without ${base}_BINARY_SHA256`);
    }

    // A fetch call's checksum is a pinned *_SHA256 or a row of a pinned table.
    for (const line of outside.filter((l) => /^\s*fetch "/.test(l))) {
      const checksum = line.match(/^\s*fetch "[^"]+" "\$\{?([A-Za-z0-9_]+)\}?"/)?.[1];
      assert.ok(checksum, `${dir}: unparsed fetch call: ${line}`);
      if (checksum.endsWith("_SHA256")) {
        assert.match(assigned[checksum] ?? "", sha256, `${dir}: ${checksum}`);
      } else {
        const table = initScript.match(/^done <<'([A-Z]+)'\n([\s\S]*?)\n\1$/m);
        assert.ok(table, `${dir}: fetch with ${checksum} outside a pinned table`);
        for (const row of table[2].split("\n")) {
          assert.match(row, /^\S+ \S+ [0-9a-f]{40} \S+ [0-9a-f]{64}$/, `${dir}: unpinned row ${row}`);
        }
      }
    }

    // Every URL literal is a pinned *_URL, the package index, or a fetch call.
    for (const line of outside.filter((l) => /https?:\/\//.test(l))) {
      assert.ok(/^[A-Z0-9_]+_URL=/.test(line) || /^PYPI_INDEX=/.test(line) || /^\s*fetch "/.test(line),
        `${dir}: unpinned URL: ${line}`);
    }
  }
});

test("init scripts pin packages and keep proxies out of the image", () => {
  for (const { dir, initScript } of builtins) {
    const lines = code(initScript);
    for (const line of lines.filter((l) => /apt-get install/.test(l))) {
      const packages = line.split(/\s+/).slice(line.split(/\s+/).indexOf("install") + 1).filter((a) => !a.startsWith("-"));
      for (const pkg of packages) assert.match(pkg, /^"?[a-z0-9.+-]+=[^ ]+"?$/, `${dir}: unpinned apt package ${pkg}`);
    }
    for (const lock of initScript.matchAll(/<<'LOCK'\n([\s\S]*?)\nLOCK$/gm)) {
      for (const row of lock[1].split("\n")) assert.match(row, /^[A-Za-z0-9_.-]+==[A-Za-z0-9_.+-]+$/, `${dir}: ${row}`);
    }
    assert.doesNotMatch(initScript, /^\s*(export\s+)?(HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy)=/m, dir);
    assert.doesNotMatch(initScript, /sing-box\.oma-infra/, `${dir}: proxy address baked into the script`);
    assert.doesNotMatch(initScript, /--build-arg|^ARG /m, dir);
  }
});

test("video-production replaces auto-story-v2 with the agreed variables", () => {
  const { definition } = builtins.find((b) => b.dir === "video-production");
  assert.equal(definition.id, "env_video_production");
  assert.equal(definition.description, "内置 vfs-cli、MediaKit cli、FFmpeg 等，用于视频生产类任务。");
  assert.equal(definition.baseImage, "oma-media");
  const byName = Object.fromEntries(definition.env.map((e) => [e.name, e]));

  // Runtime proxy: platform defaults (plain, overridable after copying).
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
    assert.equal(byName[name]?.value, SING_BOX, name);
  }
  assert.equal(byName.NO_PROXY?.value, byName.no_proxy?.value);
  const bypass = byName.NO_PROXY.value.split(",");
  for (const host of ["localhost", "127.0.0.1", "::1", ".svc", ".cluster.local", ".aliyuncs.com", ".aliyun.com", ".npmmirror.com"]) {
    assert.ok(bypass.includes(host), `NO_PROXY lacks ${host}`);
  }

  // Platform secrets: every environment key of sandbox-system/base-secret
  // (key names read 2026-10-26) except the six proxy keys above, whose
  // NO_PROXY there lacks the Aliyun suffixes.
  const platform = definition.env.filter((e) => e.secretRef).map((e) => e.name).sort();
  assert.deepEqual(platform, [
    "GEMINI_VIDEO_MODEL", "GOOGLE_API_KEY", "IS_TEST", "MEDIAKIT_API_KEY", "MEDIAKIT_RUNTIME",
    "MEDIAKIT_SURFACE", "OPENGROVE_WW_ACCESS_TOKEN", "OPENGROVE_WW_BASE_URL", "OSSUTIL_BIN",
    "OSS_READ_ACCESS_KEY_ID", "OSS_READ_ACCESS_KEY_SECRET", "OSS_READ_BUCKET", "OSS_READ_ENDPOINT",
    "OSS_READ_REGION", "OSS_READ_TABLE_ID", "RUNTIME_ENV", "VFS_OSS_AK", "VFS_OSS_SK", "VFS_TOKEN",
  ]);
  assert.equal(definition.env.length, platform.length + 6);
});

test("video-production installs the live image's pinned tools and policy", () => {
  const { initScript } = builtins.find((b) => b.dir === "video-production");
  const pins = {
    VFS_CLI_URL: "https://github.com/welltop-cn/vfs-cli-dist/releases/download/v0.3.21/vfs-cli_v0.3.21_linux_amd64.tar.gz",
    VFS_CLI_SHA256: "13a8125d6083d4747fe74b6d74142121c8c272c10f77b23e5b22334ab48abacb",
    MEDIAKIT_CLI_URL: "https://github.com/volcengine/mediakit-cli/releases/download/v0.2.1/mediakit-cli_0.2.1_linux_amd64.tar.gz",
    MEDIAKIT_CLI_SHA256: "8c25ebd7c9446813dabb27700a9d4357c7d2325e528fe9caab31696aa1326987",
    OSSUTIL_URL: "https://gosspublic.alicdn.com/ossutil/v2/2.2.0/ossutil-2.2.0-linux-amd64.zip",
    OSSUTIL_SHA256: "9e02837d806cfe976ae6c1fc22557d8e0a394ca6d298b45fb9f48a360d3a67f4",
    LIBGL1_VERSION: "1.6.0-1",
    PYPI_INDEX: "https://mirrors.aliyun.com/pypi/simple/",
  };
  for (const [name, value] of Object.entries(pins)) assert.match(initScript, new RegExp(`^${name}=${value}$`, "m"), name);
  assert.match(initScript, /^VFS_CLI_POLICY='\{"environment":"test"\}'$/m);
  assert.match(initScript, /install -o root -g root -m 0644 "\$work\/policy\.json" \/etc\/vfs-cli\/policy\.json/);
  assert.match(initScript, /constrained_install "\$GEMINI_VENV" "\$work\/gemini\.lock" google-genai==2\.22\.0$/m);
  assert.match(initScript, /scenedetect==0\.7\.1 'Pillow>=10\.4,<13' 'fonttools>=4\.50,<5'$/m);
});

test("video-production carries no offline Whisper (maintainer decision 2026-10-26)", () => {
  const { initScript } = builtins.find((b) => b.dir === "video-production");
  const lines = code(initScript);
  assert.ok(!lines.some((line) => /whisper|ctranslate2/i.test(line)), "Whisper venv or packages");
  assert.ok(!lines.some((line) => /huggingface\.co|\/opt\/auto-story\/models/.test(line)), "Whisper models");
});
