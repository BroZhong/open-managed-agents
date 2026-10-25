import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILD_DRIVER,
  INIT_TRAP,
  buildContext,
  buildEnvFile,
  dockerfile,
  parseDriverReport,
  scriptFailureMessage,
  shellQuote,
} from "../src/image-builder/build-context.js";

const BASE = `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox@sha256:${"a".repeat(64)}`;
const input = {
  environmentId: "env_abc-1_Z", buildId: "envb_x-Y_9", baseImage: BASE, nonce: "n0nce",
  initScript: "apt-get install -y jq\n",
  env: [
    { name: "FOO", value: "it's $HOME `x` \"q\"\nline2" },
    { name: "PIP_INDEX_URL", value: "https://pypi.example/simple" },
    { name: "API_KEY", secretRef: { source: "environment" as const, key: "API_KEY" } },
    { name: "VFS_TOKEN", secretRef: { source: "platform" as const, key: "VFS_TOKEN" } },
  ],
  platformDefaults: { PIP_INDEX_URL: "https://mirrors.aliyun.com/pypi/simple/", NPM_CONFIG_REGISTRY: "https://registry.npmmirror.com" },
  proxy: { url: "http://sing-box.oma-infra.svc.cluster.local:7890", noProxy: "localhost,127.0.0.1,.svc,.cluster.local,.aliyuncs.com" },
};

let dirs: string[] = [];
afterEach(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs = []; });
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "oma-build-context-"));
  dirs.push(dir);
  return dir;
}

describe("the generated build context (ADR-0024 Building)", () => {
  it("generates the ADR's Dockerfile: no ARG or ENV, init through bind mounts, manifest before ownership, labels", () => {
    const text = dockerfile(input);
    expect(text).toContain(`FROM ${BASE}\n`);
    expect(text).not.toMatch(/^\s*(ARG|ENV|COPY|ADD|USER)\b/m);
    expect(text).toContain("--mount=type=bind,source=init.sh,target=/tmp/oma-init.sh");
    expect(text).toContain("--mount=type=bind,source=build.env,target=/tmp/oma-build.env");
    expect(text).toContain("cd /home/user && set -a && . /tmp/oma-build.env && set +a");
    expect(text).toContain("bash -euo pipefail /tmp/oma-init.sh");
    const manifest = text.indexOf("/opt/oma/bin/write-manifest > /opt/oma/manifest.json");
    const chown = text.indexOf("find /home/user \\( ! -user user -o ! -group user \\) -exec chown -h user:user {} +");
    expect(manifest).toBeGreaterThan(0);
    expect(chown).toBeGreaterThan(manifest);
    expect(text).toContain("rm -rf /var/lib/apt/lists/* /root/.cache /tmp/*");
    expect(text.trimEnd().split("\n").at(-1)).toBe('LABEL dev.oma.environment="env_abc-1_Z" dev.oma.build="envb_x-Y_9"');
    expect(text).not.toContain("FOO");
    expect(() => dockerfile({ ...input, buildId: "x\nRUN evil" })).toThrow("identity");
  });

  it("puts platform defaults, the build proxy and plain variables in build.env, later winning; never a secret", () => {
    const env = buildEnvFile(input);
    expect(env).not.toMatch(/API_KEY|VFS_TOKEN/);
    const dir = tmp();
    writeFileSync(join(dir, "build.env"), env);
    const out = execFileSync("bash", ["-c", `set -a && . ./build.env && set +a && env -0`], { cwd: dir, env: { PATH: process.env.PATH! } });
    const seen = Object.fromEntries(out.toString().split("\0").filter(Boolean).map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));
    expect(seen).toMatchObject({
      FOO: "it's $HOME `x` \"q\"\nline2",
      PIP_INDEX_URL: "https://pypi.example/simple",
      NPM_CONFIG_REGISTRY: "https://registry.npmmirror.com",
      HTTP_PROXY: input.proxy.url, HTTPS_PROXY: input.proxy.url, http_proxy: input.proxy.url, https_proxy: input.proxy.url,
      NO_PROXY: input.proxy.noProxy, no_proxy: input.proxy.noProxy,
    });
    expect(buildEnvFile({ ...input, proxy: null, env: [] })).not.toMatch(/PROXY/i);
    expect(buildEnvFile({ ...input, env: [{ name: "HTTPS_PROXY", value: "http://mine:3128" }] })).toMatch(/^HTTPS_PROXY='http:\/\/mine:3128'$/m);
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });

  it("names the failing line of an init script and marks the failure for the driver, through the RUN's shell plumbing", () => {
    const dir = tmp();
    const home = join(dir, "home");
    execFileSync("mkdir", ["-p", home]);
    const context = buildContext({ ...input, initScript: "echo start\nf() {\n  missing-command-xyz --flag\n}\nf\necho never\n" });
    for (const name of ["init.sh", "build.env", "init-trap.sh"]) writeFileSync(join(dir, name), context[name]!);
    // The init RUN, with its bind targets and /home/user moved into the temporary directory.
    const run = context.Dockerfile!.split("\nRUN ")[1]!.split("\nRUN ")[0]!
      .replace(/^(--mount=\S+ \\\n\s*)+/, "")
      .replaceAll("\\\n", " ")
      .replaceAll("/tmp/oma-init.sh", join(dir, "init.sh"))
      .replaceAll("/tmp/oma-build.env", join(dir, "build.env"))
      .replaceAll("/tmp/oma-init-trap.sh", join(dir, "init-trap.sh"))
      .replace("cd /home/user", `cd ${home}`);
    expect(run).not.toContain("--mount");
    const result = spawnSync("sh", ["-c", run], { encoding: "utf8", env: { PATH: process.env.PATH! } });
    expect(result.status).toBe(127);
    expect(result.stdout).toBe("start\n");
    expect(result.stderr).toMatch(/\n\[oma\] init script failed at line 3: missing-command-xyz --flag \(exit status 127\)\n/);
    expect(result.stderr).toMatch(/^OMA_INIT_FAILED n0nce exit=127$/m);
    expect(scriptFailureMessage(result.stderr, "n0nce")).toBe("The init script failed at line 3: missing-command-xyz --flag (exit status 127)");

    const ok = buildContext({ ...input, initScript: "test \"$FOO\" = \"it's \\$HOME \\`x\\` \\\"q\\\"\nline2\" && ( false ) || true\ntest \"$PWD\" = \"$HOME_EXPECTED\"\n" });
    writeFileSync(join(dir, "init.sh"), ok["init.sh"]!);
    const passed = spawnSync("sh", ["-c", run], { encoding: "utf8", env: { PATH: process.env.PATH!, HOME_EXPECTED: home } });
    expect(passed.stderr).toBe("");
    expect(passed.status).toBe(0);
  });

  it("keeps the earliest failure location of an attempt and falls back to the exit status", () => {
    const log = [
      "STEP 2/4: RUN … echo \"OMA_INIT_FAILED n0nce exit=$status\" …",
      "[oma] init script failed at line 3: false (exit status 1)",
      "[oma] init script failed at line 3: ( cd /tmp && false ) (exit status 1)",
      "OMA_INIT_FAILED n0nce exit=1",
    ].join("\n");
    expect(scriptFailureMessage(log, "n0nce")).toBe("The init script failed at line 3: false (exit status 1)");
    expect(scriptFailureMessage("OMA_INIT_FAILED n0nce exit=2\n", "n0nce")).toBe("The init script exited with status 2");
    expect(scriptFailureMessage("nothing\n", "n0nce")).toBe("The init script failed");
    expect(INIT_TRAP).toContain("unset BASH_ENV");
  });

  it("reads the driver's report from the termination message, else from this attempt's last marker", () => {
    const pushed = `{"stage":"pushed","digest":"sha256:${"d".repeat(64)}"}`;
    expect(parseDriverReport(pushed, "n0nce")).toEqual({ stage: "pushed", digest: `sha256:${"d".repeat(64)}` });
    expect(parseDriverReport(`x\nOMA_BUILD_RESULT other {"stage":"pushed","digest":"sha256:${"e".repeat(64)}"}\nOMA_BUILD_RESULT n0nce {"stage":"push"}\n`, "n0nce")).toEqual({ stage: "push" });
    expect(parseDriverReport('{"stage":"pushed","digest":"latest"}', "n0nce")).toBeUndefined();
    expect(parseDriverReport('{"stage":"anything"}', "n0nce")).toBeUndefined();
    expect(parseDriverReport(undefined, "n0nce")).toBeUndefined();
  });

  it("drives buildah as #299 settled: separate pull, chroot isolation, one OCI manifest pushed with its digest", () => {
    expect(BUILD_DRIVER).toContain('buildah pull --quiet "docker://$OMA_BASE_IMAGE"');
    expect(BUILD_DRIVER).toContain("buildah build --isolation chroot --pull=never --layers=false --format oci");
    expect(BUILD_DRIVER).toContain('buildah push --quiet --digestfile /tmp/oma-digest "$OMA_TARGET_IMAGE" "docker://$OMA_TARGET_IMAGE"');
    expect(BUILD_DRIVER).not.toMatch(/manifest push|--all|--build-arg|ARG /);
    const context = buildContext(input);
    expect(Object.keys(context).sort()).toEqual(["Dockerfile", "build.env", "build.sh", "init-trap.sh", "init.sh", "storage.conf"]);
    expect(context["storage.conf"]).toMatch(/driver = "overlay"/);
    expect(context["storage.conf"]).not.toMatch(/mount_program|vfs/);
    expect(spawnSync("bash", ["-n", "-c", BUILD_DRIVER]).status).toBe(0);
  });
});
