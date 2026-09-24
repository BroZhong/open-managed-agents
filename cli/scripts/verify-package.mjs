// Local, credential-free tarball installation verification.
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { fixture, json, run } from "../test/helpers.mjs";
const packageRoot = new URL("..", import.meta.url).pathname;
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
  const bin = join(dir, "node_modules/oma-cli-local/dist/main.js");
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
  server = await fixture((req, res) =>
    json(
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
  const text = execFileSync(
    join(dir, "node_modules/.bin/oma-cli"),
    ["--version"],
    { cwd: dir, encoding: "utf8" },
  );
  assert.equal(text.trim(), "0.1.0");
  console.log(
    JSON.stringify(
      {
        version: "0.1.0",
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
