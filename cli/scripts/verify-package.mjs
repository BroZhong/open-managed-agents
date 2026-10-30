// Local, credential-free tarball installation verification.
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { fixture, json, run } from "../test/helpers.mjs";
const packageRoot = new URL("..", import.meta.url).pathname;
const { version } = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const dir = await realpath(await mkdtemp(join(tmpdir(), "oma-installed-")));
let server;
try {
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", dir], {
      cwd: packageRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  const tarball = join(dir, packed[0].filename);
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--omit=dev", "--prefix", dir, tarball],
    { stdio: "pipe" },
  );
  const bin = join(dir, "node_modules/@welltop/oma-cli/dist/main.js");
  for (const args of [
    ["--help"],
    ["--version"],
    ["version"],
    ["schema"],
    ["guide", "read", "--name", "oma-cli", "--raw"],
  ]) {
    const r = await run(args, { bin, cwd: dir });
    assert.equal(r.code, 0, r.stderr);
  }
  const environment = {
    id: "env_video_production", name: "video-production", ownerType: "platform",
    baseImage: "oma-media", status: "ready", description: "fixture", updatedAt: "2026-10-26T00:00:00Z",
    env: [{ name: "GEMINI_API_KEY", secretRef: { source: "platform", key: "GEMINI_API_KEY" } }],
  };
  server = await fixture((req, res) =>
    req.url.includes("/v1/environments")
      ? json(res, req.url.endsWith("/v1/environments") ? { data: [environment] } : environment)
      : json(
      res,
      req.url.includes("/a1")
        ? {
            id: "a1",
            name: "installed",
            runtime: "mock",
            model: "test",
            system: "x",
          }
        : {
            data: [
              { id: "a1", name: "installed", runtime: "mock", model: "test" },
            ],
            has_more: false,
          },
    ),
  );
  const env = {
    OMA_BASE_URL: server.url + "/prefix",
    OMA_API_KEY: "fixture-only",
  };
  const list = await run(["agent", "list"], { bin, cwd: dir, env });
  assert.equal(list.code, 0, list.stderr);
  const get = await run(
    ["agent", "get", "--agent-id", list.data().data[0].id],
    { bin, cwd: dir, env },
  );
  assert.equal(get.data().data.system, "x");
  const environments = await run(["environment", "list"], { bin, cwd: dir, env });
  assert.equal(environments.code, 0, environments.stderr);
  assert.equal(environments.data().data[0].id, "env_video_production");
  const environmentGet = await run(["environment", "get", "--environment-id", "env_video_production"], { bin, cwd: dir, env });
  assert.equal(environmentGet.code, 0, environmentGet.stderr);
  assert.equal(environmentGet.data().data.baseImage, "oma-media");
  for (const path of [["environment", "create"], ["environment", "logs"], ["agent", "update"]]) {
    const schema = await run(["schema", ...path], { bin, cwd: dir });
    assert.equal(schema.code, 0, schema.stderr);
  }
  const text = execFileSync(
    join(dir, "node_modules/.bin/oma-cli"),
    ["--version"],
    { cwd: dir, encoding: "utf8" },
  );
  assert.equal(text.trim(), version);
  console.log(
    JSON.stringify(
      {
        version,
        runtime: process.version,
        sha256: createHash("sha256")
          .update(await readFile(tarball))
          .digest("hex"),
        files: packed[0].files.map((x) => x.path),
        checks: [
          "independent install",
          "executable bin",
          "offline discovery",
          "fixture list → get",
          "fixture environment list → get",
          "offline environment and agent schemas",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  if (server) await server.close();
  await rm(dir, { recursive: true, force: true });
}
