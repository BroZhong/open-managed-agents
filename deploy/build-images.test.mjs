import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The Server and Web images are tagged with their build time in Beijing time
// (YYYYMMDDHHmm), never with a deployment, labelled with their Git revision,
// and a pushed tag is never overwritten.
const root = new URL("../", import.meta.url).pathname;
const script = join(root, "deploy/scripts/build-images.sh");
const registry = "registry-vpc.cn-shanghai.aliyuncs.com/welltop";
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }) !== "";

const beijing = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Shanghai", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
const beijingMinute = (at = new Date()) => {
  const part = Object.fromEntries(beijing.formatToParts(at).map(({ type, value }) => [type, value]));
  return `${part.year}${part.month}${part.day}${part.hour}${part.minute}`;
};

/**
 * Run a dry run with a stand-in `docker` whose registry holds `existing`
 * tags; retried when the minute turns during the run. Resolves with the
 * minute the run saw and its result.
 */
function dryRun(args, { tz = "UTC", existing = (minute) => [] } = {}) {
  const bin = mkdtempSync(join(tmpdir(), "oma-build-images-test-"));
  try {
    const docker = join(bin, "docker");
    writeFileSync(docker, '#!/bin/sh\n[ "$1" = manifest ] && [ "$2" = inspect ] || { echo "unexpected docker $*" >&2; exit 3; }\ngrep -Fqx -- "$3" "$FAKE_REGISTRY"\n');
    chmodSync(docker, 0o755);
    for (;;) {
      const minute = beijingMinute();
      writeFileSync(join(bin, "registry"), existing(minute).map((ref) => `${ref}\n`).join(""));
      const result = spawnSync("bash", [script, "--dry-run", "--allow-dirty", ...args], {
        encoding: "utf8", env: { ...process.env, TZ: tz, PATH: `${bin}:${process.env.PATH}`, FAKE_REGISTRY: join(bin, "registry") },
      });
      if (beijingMinute() === minute) return { minute, ...result };
    }
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

const releaseTag = (stdout) => stdout.match(/^Release images \(tag (\S+), git (\S+)\):$/m)?.slice(1);

test("the default tag is the Beijing build minute whatever the time zone, -dirty for a dirty checkout", () => {
  for (const tz of ["UTC", "Asia/Shanghai", "America/Los_Angeles"]) {
    const { minute, status, stdout, stderr } = dryRun(["server", "web"], { tz });
    assert.equal(status, 0, stderr);
    const tag = dirty ? `${minute}-dirty` : minute;
    assert.deepEqual(releaseTag(stdout), [tag, dirty ? `${revision}-dirty` : revision]);
    assert.match(stdout, new RegExp(`^SERVER_IMAGE=${registry}/oma-server:${tag}$`, "m"));
    assert.match(stdout, new RegExp(`^WEB_IMAGE=${registry}/oma-web:${tag}$`, "m"));
    assert.match(stdout, new RegExp(`^GIT_REVISION=${revision}$`, "m"));
  }
});

test("both images carry the OCI revision and creation labels", () => {
  const { minute, status, stdout, stderr } = dryRun(["server", "web"]);
  assert.equal(status, 0, stderr);
  const builds = stdout.split("\n").filter((line) => line.startsWith("+ docker buildx build"));
  assert.equal(builds.length, 2);
  const created = `${minute.slice(0, 4)}-${minute.slice(4, 6)}-${minute.slice(6, 8)}T${minute.slice(8, 10)}:${minute.slice(10, 12)}:\\d\\d\\+08:00`;
  for (const build of builds) {
    assert.match(build, new RegExp(` --label org\\.opencontainers\\.image\\.revision=${revision} `));
    assert.match(build, new RegExp(` --label org\\.opencontainers\\.image\\.created=${created} `));
  }
});

test("with --push a default tag an image already has gains -2, -3, … for every image alike", () => {
  const { minute, status, stdout, stderr } = dryRun(["--push", "server", "web"], {
    existing: (minute) => {
      const tag = dirty ? `${minute}-dirty` : minute;
      return [`${registry}/oma-server:${tag}`, `${registry}/oma-web:${tag}-2`];
    },
  });
  assert.equal(status, 0, stderr);
  const tag = `${dirty ? `${minute}-dirty` : minute}-3`;
  assert.equal(releaseTag(stdout)?.[0], tag);
  assert.match(stdout, new RegExp(`^SERVER_IMAGE=${registry}/oma-server:${tag}$`, "m"));
  assert.match(stdout, new RegExp(`^WEB_IMAGE=${registry}/oma-web:${tag}$`, "m"));
});

test("an explicit --tag is used as given, and refused with --push when an image already has it", () => {
  const given = dryRun(["--tag", "release-1", "server"]);
  assert.equal(given.status, 0, given.stderr);
  assert.equal(releaseTag(given.stdout)?.[0], "release-1");

  const refused = dryRun(["--push", "--tag", "release-1", "server", "web"], { existing: () => [`${registry}/oma-web:release-1`] });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, new RegExp(`Refusing to overwrite an existing tag: ${registry}/oma-web:release-1`));
  assert.doesNotMatch(refused.stdout, /docker buildx build/);
});
