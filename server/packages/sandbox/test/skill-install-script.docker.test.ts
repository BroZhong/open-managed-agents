/**
 * The real `skill-install.sh` in a Debian 12 container (ADR-0022). Every
 * other Skill Install test runs against the FakeSandboxClient's emulation;
 * this one runs the script itself as root, with its request on an stdin that
 * is never closed, against an HTTPS fixture server standing in for OSS. It
 * checks byte-exact files (a TTF included), root ownership and 0555/0444, a
 * refused write by the Sandbox user, downloads of changed bundles only, the
 * projected-directory migration, the empty Set, download/verify/stdin
 * failures, two concurrent installs, the switch generation order, and a
 * SIGKILL mid-download that leaves /skills in place and the lock free.
 *
 * Opt-in, because it needs Docker and a network for apt:
 *
 *   SKILL_INSTALL_DOCKER_TEST=1 pnpm --dir server --filter @oma-server/sandbox \
 *     exec vitest run test/skill-install-script.docker.test.ts
 *
 * Optional:
 *   SKILL_INSTALL_DOCKER_IMAGE       base image, default debian:12-slim (any Debian 12 with apt)
 *   SKILL_INSTALL_DOCKER_APT_MIRROR  apt host replacing deb.debian.org, e.g. mirrors.aliyun.com
 *
 * The first run installs curl, unzip, ca-certificates, util-linux and socat
 * into the base image with apt and commits the result as
 * `oma-skill-install-test:<hash>`; later runs reuse it. The fixture server runs
 * in this process; inside the container socat forwards localhost:443 to it,
 * because the script accepts only `https://<host>/` URLs without a port. The
 * container is removed afterwards; the committed image is kept.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { packSkillBundle, skillSetHash, type SkillBundleInputFile } from "@oma-server/store";
import { SKILL_INSTALL_PROTOCOL, SKILL_INSTALL_SCRIPT } from "../src/skill-install.js";

const enabled = process.env.SKILL_INSTALL_DOCKER_TEST === "1";
const BASE_IMAGE = process.env.SKILL_INSTALL_DOCKER_IMAGE ?? "debian:12-slim";
const APT_MIRROR = process.env.SKILL_INSTALL_DOCKER_APT_MIRROR;
const PACKAGES = "curl unzip ca-certificates util-linux socat";
const IMAGE = `oma-skill-install-test:${createHash("sha256").update(`${BASE_IMAGE}\n${PACKAGES}`).digest("hex").slice(0, 12)}`;
const CONTAINER = `oma-skill-install-test-${randomBytes(4).toString("hex")}`;
const CA_BUNDLE = "/tmp/oma-fixture-cert.pem";
/** Present in every signed URL: it must never reach output, argv, env or a file. */
const SECRET = "SIGNATURE-SECRET-0123456789";

const enc = (text: string) => new TextEncoder().encode(text);
/** A TrueType header and every byte value, repeated: survives only a byte-exact path. */
const FONT = new Uint8Array(4096).map((_, index) => index < 6 ? [0, 1, 0, 0, 0, 12][index] : (index * 131 + 7) % 256);
const BIG = new Uint8Array(1_000_000).map((_, index) => (index * 7919) % 251);

interface Bundle { sha256: string; zip: Buffer; files: Record<string, { sha256: string; mode: number }> }
interface SkillSetFixture { setHash: string; members: Array<{ name: string; sha256: string }> }
interface Run { code: number | null; stdout: string; stderr: string; result?: Record<string, unknown> }

function docker(args: string[], input?: string): { code: number | null; stdout: string; stderr: string } {
  const run = spawnSync("docker", args, { input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}
/** A root shell command in the container; throws unless it exits 0. */
function sh(command: string, user = "0:0"): string {
  const run = docker(["exec", "--user", user, CONTAINER, "bash", "-c", command]);
  if (run.code !== 0) throw new Error(`${command} exited ${run.code}: ${run.stderr}`);
  return run.stdout;
}

/** Build the test image once: the base image with the tools the Sandbox image provides. */
function ensureImage(): void {
  if (docker(["image", "inspect", IMAGE]).code === 0) return;
  const prepare = `${APT_MIRROR ? `sed -i 's#deb.debian.org#${APT_MIRROR}#g' /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null; ` : ""}` +
    `apt-get update -o Acquire::Retries=3 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${PACKAGES} && rm -rf /var/lib/apt/lists/*`;
  const builder = `${CONTAINER}-build`;
  const built = docker(["run", "--name", builder, "--user", "0:0", "--entrypoint", "bash", BASE_IMAGE, "-c", prepare]);
  try {
    if (built.code !== 0) throw new Error(`preparing ${BASE_IMAGE} failed (${built.code}): ${(built.stdout + built.stderr).slice(-3000)}`);
    const committed = docker(["commit", builder, IMAGE]);
    if (committed.code !== 0) throw new Error(`docker commit failed: ${committed.stderr}`);
  } finally {
    docker(["rm", "-f", builder]);
  }
}

/** The fixture OSS: bundles by sha256, per-sha request counts, failures and held responses chosen by query. */
function fixtureServer(key: string, cert: string, bundles: Map<string, Buffer>) {
  const requests = new Map<string, number>();
  const holds = new Map<string, () => void>();
  const held = new Map<string, Promise<void>>();
  const server: Server = createServer({ key, cert }, async (request, response) => {
    const url = new URL(request.url ?? "/", "https://localhost");
    const sha = /^\/([0-9a-f]{64})\.zip$/.exec(url.pathname)?.[1];
    if (sha) requests.set(sha, (requests.get(sha) ?? 0) + 1);
    const hold = url.searchParams.get("hold");
    if (hold) await held.get(hold);
    if (url.searchParams.get("status")) { response.writeHead(Number(url.searchParams.get("status"))); response.end(); return; }
    const body = sha && bundles.get(url.searchParams.get("serve") ?? sha);
    if (!body) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "content-length": body.length });
    response.end(body);
  });
  return {
    server, requests,
    /** Responses for `?hold=<id>` wait until released. */
    hold(id: string) { held.set(id, new Promise<void>((resolve) => holds.set(id, resolve))); },
    release(id: string) { holds.get(id)?.(); },
  };
}

describe.skipIf(!enabled)("skill-install.sh in a Debian 12 container", () => {
  const bundles = new Map<string, Bundle>();
  const zips = new Map<string, Buffer>();
  let fixture: ReturnType<typeof fixtureServer>;

  async function bundle(key: string, files: SkillBundleInputFile[]): Promise<Bundle> {
    const packed = await packSkillBundle(files);
    const entry = { sha256: packed.sha256, zip: Buffer.from(packed.bytes), files: Object.fromEntries(files.map((file) => [file.path, {
      sha256: createHash("sha256").update(file.body).digest("hex"), mode: file.mode && file.mode & 0o111 ? 0o555 : 0o444,
    }])) };
    bundles.set(key, entry);
    zips.set(entry.sha256, entry.zip);
    return entry;
  }
  const set = (members: Array<[name: string, key: string]>): SkillSetFixture => ({
    setHash: skillSetHash(members.map(([name, key]) => ({ name, bundleSha256: bundles.get(key)!.sha256 }))),
    members: members.map(([name, key]) => ({ name, sha256: bundles.get(key)!.sha256 })),
  });
  const request = (skills: SkillSetFixture, { budget = 20, query = "", url }: { budget?: number; query?: string; url?: (sha: string) => string } = {}) => [
    `${SKILL_INSTALL_PROTOCOL} ${skills.setHash} ${skills.members.length} ${budget}`,
    ...skills.members.map(({ name, sha256 }) => `${sha256} ${Buffer.from(name).toString("base64")} ${url?.(sha256) ?? `https://localhost/${sha256}.zip?OSSAccessKeyId=AK&Expires=1&Signature=${SECRET}${query}`}`),
  ].join("\n") + "\n";

  const outputs: string[] = [];
  /** Run the real script as root. Stdin stays open, as the Sandbox's envd never closes it. */
  function install(input: string, { closeStdin = false } = {}): Promise<Run> {
    const child = spawn("docker", ["exec", "-i", "-e", `CURL_CA_BUNDLE=${CA_BUNDLE}`, CONTAINER, "bash", "-c", SKILL_INSTALL_SCRIPT, "oma-skill-install"]);
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.stdin.write(input);
    if (closeStdin) child.stdin.end();
    return new Promise((resolve) => child.on("close", (code) => {
      child.stdin.destroy();
      outputs.push(stdout, stderr);
      const line = stdout.split("\n").filter((text) => text.startsWith("OMA_SKILLS_RESULT ")).at(-1);
      resolve({ code, stdout, stderr, result: line ? JSON.parse(line.slice("OMA_SKILLS_RESULT ".length)) : undefined });
    }));
  }
  const target = () => sh("readlink /skills || true").trim();
  const versions = () => sh("ls -1 /opt/oma/skills | grep -E '^[0-9a-f]{64}$' || true").split("\n").filter(Boolean).sort();
  const cachedBundles = () => sh("ls -1 /opt/oma/skills/bundles").split("\n").filter(Boolean).sort();
  /** Pids of the install's main bash: its last argument is the script name, unlike its parent's. */
  const mainInstallPids = () => sh(String.raw`script() { [[ $(tr '\0' '\n' <"$1/cmdline" 2>/dev/null | tail -n 1) == oma-skill-install ]]; }
    for p in /proc/[0-9]*; do
      script "$p" || continue
      script "/proc/$(awk '/^PPid/{print $2}' "$p/status")" || echo "$p" | cut -d/ -f3
    done; true`).split("\n").filter(Boolean);
  /** Pids of every process with the install lock file open. */
  const lockHolders = () => sh(String.raw`for p in /proc/[0-9]*; do
      ls -l "$p/fd" 2>/dev/null | grep -q /opt/oma/skills/.lock && echo "$p" | cut -d/ -f3; done; true`).split("\n").filter(Boolean);
  /** Pids of running curl processes. */
  const curls = () => sh(String.raw`for p in /proc/[0-9]*; do [[ $(cat "$p/comm" 2>/dev/null) == curl ]] && echo "$p" | cut -d/ -f3; done; true`).split("\n").filter(Boolean);
  const waitFor = async (check: () => boolean, what: string, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  /** Assert /skills is exactly `skills`: byte-exact files, 0555/0444, all owned by root. */
  function expectInstalled(skills: SkillSetFixture, keys: Record<string, string>) {
    expect(target()).toBe(`/opt/oma/skills/${skills.setHash}`);
    const listing = sh(String.raw`cd /skills/ && find . -mindepth 1 -printf '%y %m %U:%G %P\n'`).split("\n").filter(Boolean).sort();
    const sums = Object.fromEntries(sh("cd /skills/ && find . -type f -print0 | xargs -0r sha256sum").split("\n").filter(Boolean)
      .map((line) => [line.slice(66).replace(/^\.\//, ""), line.slice(0, 64)]));
    const expected: string[] = [];
    for (const { name } of skills.members) {
      const files = bundles.get(keys[name])!.files;
      const dirs = new Set([name, ...Object.keys(files).flatMap((path) => path.split("/").slice(0, -1).map((_, index, parts) => `${name}/${parts.slice(0, index + 1).join("/")}`))]);
      for (const dir of dirs) expected.push(`d 555 0:0 ${dir}`);
      for (const [path, file] of Object.entries(files)) {
        expected.push(`f ${file.mode.toString(8)} 0:0 ${name}/${path}`);
        expect(sums[`${name}/${path}`], `${name}/${path}`).toBe(file.sha256);
      }
    }
    expect(listing).toEqual(expected.sort());
    expect(sh(String.raw`stat -c '%a %U' /opt/oma/skills/${skills.setHash}`).trim()).toBe("555 root");
  }

  let A: SkillSetFixture, B: SkillSetFixture, C: SkillSetFixture, D: SkillSetFixture, E: SkillSetFixture, X: SkillSetFixture, EMPTY: SkillSetFixture;
  beforeAll(async () => {
    if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) throw new Error("SKILL_INSTALL_DOCKER_TEST=1 needs a running Docker daemon");
    await bundle("alpha", [
      { path: "SKILL.md", body: enc("---\nname: alpha\n---\nalpha v1\n") },
      { path: "bin/run.sh", body: enc("#!/bin/sh\necho alpha-ok\n"), mode: 0o755 },
      { path: "assets/fonts/LiberationSans-Regular.ttf", body: FONT },
      { path: "docs/中文 空格.txt", body: enc("unicode name\n") },
      { path: "deep/a/b/c/d/e/f.txt", body: enc("deep\n"), mode: 0o600 },
    ]);
    await bundle("beta", [{ path: "SKILL.md", body: enc("beta v1\n") }]);
    await bundle("beta2", [{ path: "SKILL.md", body: enc("beta v2\n") }, { path: "notes.md", body: enc("new file\n") }]);
    await bundle("delta", [{ path: "SKILL.md", body: enc("delta\n") }, { path: "data/big.bin", body: BIG }]);
    await bundle("empty", []);
    await bundle("xray", [{ path: "SKILL.md", body: enc("x\n") }]);
    A = set([["alpha", "alpha"], ["beta", "beta"]]);
    B = set([["alpha", "alpha"], ["beta", "beta2"]]);
    C = set([["gamma 伽马", "alpha"], ["beta", "beta2"]]);
    D = set([["delta", "delta"], ["beta", "beta2"]]);
    E = set([["delta", "delta"], ["nothing", "empty"]]);
    X = set([["xray", "xray"]]);
    EMPTY = set([]);

    ensureImage();
    const started = docker(["run", "-d", "--name", CONTAINER, "--add-host=host.docker.internal:host-gateway", "--entrypoint", "sleep", IMAGE, "infinity"]);
    if (started.code !== 0) throw new Error(`docker run failed: ${started.stderr}`);
    const pem = sh(`openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost -addext subjectAltName=DNS:localhost \
      -keyout /tmp/oma-fixture-key.pem -out ${CA_BUNDLE} >/dev/null 2>&1 && cat /tmp/oma-fixture-key.pem ${CA_BUNDLE}`);
    const key = /-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----\n/.exec(pem)![0];
    const cert = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----\n/.exec(pem)![0];
    fixture = fixtureServer(key, cert, zips);
    // Docker Desktop reaches host loopback through host.docker.internal; Linux needs the bridge.
    await new Promise<void>((resolve) => fixture.server.listen(0, process.platform === "linux" ? "0.0.0.0" : "127.0.0.1", resolve));
    const port = (fixture.server.address() as AddressInfo).port;
    docker(["exec", "-d", CONTAINER, "socat", "TCP-LISTEN:443,fork,reuseaddr,bind=127.0.0.1", `TCP:host.docker.internal:${port}`]);
    await waitFor(() => docker(["exec", CONTAINER, "bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/443"]).code === 0, "the fixture forwarder");
  }, 900_000);

  afterAll(async () => {
    if (!enabled) return;
    docker(["rm", "-f", CONTAINER]);
    fixture?.server.closeAllConnections();
    await new Promise((resolve) => fixture?.server.close(resolve));
  }, 60_000);

  it("installs byte-exact read-only Skills owned by root that the Sandbox user can run but not change", async () => {
    const run = await install(request(A));
    expect(run).toMatchObject({ code: 0, result: { ok: true, reused: 0, skills: 2, downloaded: 2, legacy: 0 } });
    expectInstalled(A, { alpha: "alpha", beta: "beta" });
    expect(sh("/skills/alpha/bin/run.sh", "1000:1000").trim()).toBe("alpha-ok");
    const attempts = sh(String.raw`for try in "echo x > /skills/alpha/SKILL.md" "touch /skills/alpha/new" "rm -f /skills/beta/SKILL.md" "rm -f /skills" "ln -sfn /tmp /skills"; do
        if (eval "$try") 2>/dev/null; then echo "WROTE: $try"; else echo refused; fi; done`, "1000:1000");
    expect(attempts.split("\n").filter(Boolean)).toEqual(["refused", "refused", "refused", "refused", "refused"]);
    expectInstalled(A, { alpha: "alpha", beta: "beta" });
  }, 120_000);

  it("downloads only bundles the Sandbox lacks and keeps the current and previous versions", async () => {
    const before = new Map(fixture.requests);
    const changed = await install(request(B));
    expect(changed).toMatchObject({ code: 0, result: { ok: true, downloaded: 1, reused: 0 } });
    expect(fixture.requests.get(bundles.get("beta2")!.sha256)).toBe(1);
    expect(fixture.requests.get(bundles.get("alpha")!.sha256)).toBe(before.get(bundles.get("alpha")!.sha256));
    expectInstalled(B, { alpha: "alpha", beta: "beta2" });
    expect(versions()).toEqual([A.setHash, B.setHash].sort());
    // A rename reuses the cached bundle; the oldest version and the bundle only it used are removed.
    const renamed = await install(request(C));
    expect(renamed).toMatchObject({ code: 0, result: { ok: true, downloaded: 0, reused: 0 } });
    expectInstalled(C, { "gamma 伽马": "alpha", beta: "beta2" });
    expect(versions()).toEqual([B.setHash, C.setHash].sort());
    expect(cachedBundles()).toEqual([bundles.get("alpha")!.sha256, bundles.get("beta2")!.sha256].sort());
    // Switching back reuses the previous version directory.
    const back = await install(request(B));
    expect(back).toMatchObject({ code: 0, result: { ok: true, reused: 1, downloaded: 0 } });
    expectInstalled(B, { alpha: "alpha", beta: "beta2" });
  }, 120_000);

  it("moves a projected /skills directory aside and installs the empty Set", async () => {
    sh("rm -f /skills && mkdir -p /skills/old && echo projected > /skills/old/SKILL.md");
    const migrated = await install(request(B));
    expect(migrated).toMatchObject({ code: 0, result: { ok: true, legacy: 1, reused: 1 } });
    expectInstalled(B, { alpha: "alpha", beta: "beta2" });
    expect(sh("ls -d /opt/oma/skills/legacy-* 2>/dev/null || true").trim()).toBe("");
    const empty = await install(request(EMPTY));
    expect(empty).toMatchObject({ code: 0, result: { ok: true, skills: 0 } });
    expect(target()).toBe(`/opt/oma/skills/${EMPTY.setHash}`);
    expect(sh("ls -A /skills/").trim()).toBe("");
  }, 120_000);

  it("fails at download, verify and start without switching /skills, downloading each bundle once per attempt", async () => {
    const before = target();
    const missing = await install(request(D, { url: (sha) => `https://localhost/${"0".repeat(64)}.zip?Signature=${SECRET}&for=${sha}` }));
    expect(missing).toMatchObject({ code: 1, result: { ok: false, stage: "download", reason: expect.stringContaining("HTTP 404") } });
    const unavailable = await install(request(D, { query: "&status=503" }));
    expect(unavailable).toMatchObject({ code: 1, result: { ok: false, stage: "download", reason: expect.stringContaining("HTTP 503") } });
    // One round: the Host's single retry of the whole attempt is the only retry.
    expect(fixture.requests.get(bundles.get("delta")!.sha256)).toBe(1);
    const corrupt = await install(request(D, { query: `&serve=${bundles.get("beta")!.sha256}` }));
    expect(corrupt).toMatchObject({ code: 1, result: { ok: false, stage: "verify", reason: expect.stringContaining("sha256 mismatch") } });
    expect(target()).toBe(before);
    expect(versions()).not.toContain(D.setHash);
    const malformed = await install("not a request\n");
    expect(malformed.result).toMatchObject({ ok: false, stage: "start", reason: "malformed install request" });
    const incomplete = await install(request(D).split("\n")[0] + "\n", { closeStdin: true });
    expect(incomplete.result).toMatchObject({ ok: false, stage: "start", reason: "the install request ended early" });
    const none = await install("", { closeStdin: true });
    expect(none.result).toMatchObject({ ok: false, stage: "start", reason: "no install request arrived on stdin" });
    expect(target()).toBe(before);
  }, 120_000);

  it("lets two installers of one version run at once: one downloads, the other reuses", async () => {
    const runs = await Promise.all([install(request(D)), install(request(D))]);
    expect(runs.map((run) => run.result?.ok)).toEqual([true, true]);
    expect(runs.map((run) => run.result?.downloaded).sort()).toEqual([0, 1]);
    expectInstalled(D, { delta: "delta", beta: "beta2" });
  }, 120_000);

  it("gives each switch a higher generation, so the highest names what /skills points at", async () => {
    const first = await install(request(E));
    const second = await install(request(D));
    expect(Number(second.result?.generation)).toBeGreaterThan(Number(first.result?.generation));
    // Y holds the lock in a slow download while X queues behind it: X switches last.
    sh(`rm -rf /opt/oma/skills/${E.setHash} /opt/oma/skills/bundles/${bundles.get("empty")!.sha256}`);
    fixture.hold("y");
    const y = install(request(E, { query: "&hold=y" }));
    await waitFor(() => fixture.requests.get(bundles.get("empty")!.sha256) === 2, "Y's download");
    const x = install(request(X));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    fixture.release("y");
    const [ranY, ranX] = await Promise.all([y, x]);
    expect([ranY.result?.ok, ranX.result?.ok]).toEqual([true, true]);
    expect(Number(ranX.result?.generation)).toBeGreaterThan(Number(ranY.result?.generation));
    expect(target()).toBe(`/opt/oma/skills/${X.setHash}`);
  }, 120_000);

  it("survives a SIGKILL mid-download: /skills keeps its target, and the orphaned download holds no lock", async () => {
    const before = target();
    fixture.hold("kill");
    const killed = install(request(C, { query: "&hold=kill" }));
    // C's alpha was evicted from the cache, so it is downloaded and held.
    await waitFor(() => fixture.requests.get(bundles.get("alpha")!.sha256)! >= 2, "the held download");
    const [pid] = mainInstallPids();
    expect(pid).toMatch(/^\d+$/);
    // Kill only the script's own process, as a lost Runner or a kill RPC that reaches one pid would.
    sh(`kill -9 ${pid}`);
    expect((await killed).result).toBeUndefined();
    // The download outlives the script; nothing it left behind holds the lock.
    expect(curls().length).toBeGreaterThan(0);
    expect(lockHolders()).toEqual([]);
    expect(target()).toBe(before);
    expect(versions()).not.toContain(C.setHash);
    // The next install takes the lock at once, while the orphan still waits for its response.
    const startedAt = Date.now();
    const next = await install(request(X, { budget: 5 }));
    expect(next).toMatchObject({ code: 0, result: { ok: true } });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(target()).toBe(`/opt/oma/skills/${X.setHash}`);
    fixture.release("kill");
    const retry = await install(request(C));
    expect(retry).toMatchObject({ code: 0, result: { ok: true } });
    expectInstalled(C, { "gamma 伽马": "alpha", beta: "beta2" });
  }, 120_000);

  it("never exposes a signed URL in output, argv, env or files", async () => {
    sh(`rm -rf /opt/oma/skills/${E.setHash} /opt/oma/skills/bundles/${bundles.get("delta")!.sha256}`);
    fixture.hold("probe");
    const running = install(request(E, { query: "&hold=probe" }));
    await waitFor(() => curls().length > 0, "curl");
    // The pattern is assembled in the shell, so the sampler's own argv does not contain it.
    const [head, tail] = [SECRET.slice(0, 8), SECRET.slice(8)];
    const sampled = sh(String.raw`n=0; for p in /proc/[0-9]*; do for part in cmdline environ; do
        if grep -qa "${head}""${tail}" "$p/$part" 2>/dev/null; then echo "LEAK $p/$part"; fi; n=$((n + 1)); done; done; echo "samples=$n"`);
    fixture.release("probe");
    await running;
    expect(sampled).not.toContain("LEAK");
    expect(sh(`grep -rla ${SECRET} /opt/oma /tmp /root /var/tmp /etc 2>/dev/null || true`).trim()).toBe("");
    expect(outputs.join("\n")).not.toContain(SECRET);
  }, 120_000);
});
