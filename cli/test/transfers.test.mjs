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
import { checkChain } from "../dist/local-files.js";

test("accepts the macOS root alias used by os.tmpdir but rejects nested symlinks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oma-root-alias-"));
  try {
    await checkChain(dir, "directory");
    const target = join(dir, "target");
    const link = join(dir, "link");
    await mkdir(target);
    await symlink(target, link);
    await assert.rejects(
      () => checkChain(link, "directory"),
      /Symbolic links are not allowed:/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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

test("recursive upload preflights the entire tree and reports lost submissions as unknown without retry", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "oma-upload-")));
  await writeFile(join(dir, "a.txt"), "A");
  await writeFile(join(dir, "b.txt"), "B");
  let conflicts = true;
  let posts = 0;
  const f = await fixture((req, res) => {
    if (req.method === "POST") {
      posts++;
      if (posts === 1) json(res, { data: [{ path: "root/a.txt" }] });
      else req.socket.destroy();
    } else
      json(
        res,
        req.url.includes("/files")
          ? {
              data: conflicts
                ? [{ path: "root/b.txt", size: 1, updated_at: null }]
                : [],
            }
          : { id: "w" },
      );
  });
  try {
    const args = [
      "workspace",
      "file",
      "upload",
      "--workspace-id",
      "w",
      "--path",
      "root",
      "--file",
      dir,
      "--recursive",
    ];
    const conflict = await run(args, auth(f));
    assert.equal(conflict.code, 5);
    assert.equal(posts, 0);
    conflicts = false;
    const r = await run(args, auth(f));
    assert.equal(r.code, 1, r.stderr);
    assert.equal(r.data().ok, false);
    assert.deepEqual(r.data().meta, { succeeded: 1, failed: 0, unknown: 1 });
    assert.equal(r.data().data[1].status, "unknown");
    assert.equal(r.error().type, "partial_failure");
    assert.equal(posts, 2);
  } finally {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("incomplete signed response retains successful siblings and never commits a truncated file", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "oma-partial-")));
  const signed = await fixture((req, res) => {
    if (req.url === "/bad") {
      res.writeHead(200, { "content-length": "100" });
      res.write("partial");
      setTimeout(() => res.destroy(), 20);
    } else res.end("good");
  });
  const host = await fixture((req, res) => {
    if (req.url.includes("/files?"))
      json(res, {
        data: [
          { path: "folder/a.txt", size: 4 },
          { path: "folder/b.txt", size: 100 },
        ],
      });
    else if (req.url.includes("/files/"))
      json(res, {
        url: signed.url + (req.url.includes("b.txt") ? "/bad" : "/good"),
        size: req.url.includes("b.txt") ? 100 : 4,
      });
    else json(res, { id: "w" });
  });
  try {
    const r = await run(
      [
        "workspace",
        "file",
        "download",
        "--workspace-id",
        "w",
        "--path",
        "folder",
        "--recursive",
        "--output",
        join(dir, "out"),
      ],
      auth(host),
    );
    assert.equal(r.code, 1, r.stderr);
    assert.deepEqual(r.data().meta, { succeeded: 1, failed: 1, unknown: 0 });
    assert.equal(await readFile(join(dir, "out/a.txt"), "utf8"), "good");
    await assert.rejects(readFile(join(dir, "out/b.txt")));
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(join(dir, "out")), ["a.txt"]);
    assert.ok(
      signed.requests.every(
        (r) =>
          r.headers.authorization === undefined &&
          r.headers["x-api-key"] === undefined,
      ),
    );
  } finally {
    await host.close();
    await signed.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Skill download rejects an invalid local directory before contacting Host", async () => {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "oma-skill-output-")),
  );
  await writeFile(join(dir, "file"), "not a directory");
  const f = await fixture((req, res) =>
    json(res, { id: "s", files: ["SKILL.md"] }),
  );
  try {
    const r = await run(
      ["skill", "download", "--skill-id", "s", "--output", join(dir, "file")],
      auth(f),
    );
    assert.equal(r.code, 2, r.stderr);
    assert.equal(f.requests.length, 0);
  } finally {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});
