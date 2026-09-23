import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, json, run, auth } from "./helpers.mjs";
test("recursive binary download preserves relative structure; conflicts and dry-run make no local writes", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "oma-test-")));
  let signed;
  signed = await fixture((req, res) => res.end(Buffer.from([0, 255, 2])));
  const host = await fixture((req, res) =>
    json(
      res,
      req.url.includes("/files?")
        ? {
            data: [
              { path: "assets/a.bin", size: 3, updated_at: null },
              { path: "assets-other/no", size: 3 },
            ],
          }
        : { url: signed.url + "/file", size: 3 },
    ),
  );
  try {
    const args = [
      "workspace",
      "file",
      "download",
      "--workspace-id",
      "w",
      "--path",
      "assets",
      "--recursive",
      "--output",
      join(dir, "out"),
    ];
    const dry = await run([...args, "--dry-run"], auth(host));
    assert.equal(dry.code, 10, dry.stderr);
    assert.rejects(readFile(join(dir, "out/a.bin")));
    const r = await run(args, auth(host));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      await readFile(join(dir, "out/a.bin")),
      Buffer.from([0, 255, 2]),
    );
    assert.equal(r.data().meta.succeeded, 1);
    const conflict = await run(args, auth(host));
    assert.equal(conflict.code, 5);
    assert.equal(signed.requests.length, 1);
    await symlink(join(dir, "out"), join(dir, "link"));
    const link = await run(
      [...args.slice(0, -1), join(dir, "link"), "--overwrite"],
      auth(host),
    );
    assert.equal(link.code, 2);
  } finally {
    await host.close();
    await signed.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("Skill upload preserves fallback directory name, detects all names before any mutation", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "oma-skills-")));
  await mkdir(join(dir, "alpha"));
  await writeFile(join(dir, "alpha/SKILL.md"), "# Test\nDescription\n");
  const f = await fixture((req, res) =>
    json(
      res,
      req.method === "GET"
        ? { data: [], has_more: false }
        : { data: [{ id: "s1", name: "alpha" }] },
      req.method === "GET" ? 200 : 201,
    ),
  );
  try {
    const r = await run(
      ["skill", "upload", "--directory", join(dir, "alpha")],
      auth(f),
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.data().data[0].name, "alpha");
    assert.match(
      f.requests.find((x) => x.method === "POST").body.toString(),
      /alpha\/SKILL.md/,
    );
    await symlink(join(dir, "alpha/SKILL.md"), join(dir, "alpha/bad"));
    const count = f.requests.length;
    const bad = await run(
      ["skill", "upload", "--directory", join(dir, "alpha")],
      auth(f),
    );
    assert.equal(bad.code, 2);
    assert.equal(f.requests.length, count);
  } finally {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});
