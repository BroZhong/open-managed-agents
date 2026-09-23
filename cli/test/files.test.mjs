import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, json, run, auth } from "./helpers.mjs";
test("Workspace signed reads isolate Host credentials and reject invalid UTF-8", async () => {
  const signed = await fixture((req, res) =>
    res.end(
      req.url === "/binary" ? Buffer.from([255, 0]) : Buffer.from("文本\n"),
    ),
  );
  const host = await fixture((req, res) =>
    json(res, {
      path: "a",
      url: signed.url + (req.url.includes("binary") ? "/binary" : "/text"),
      contentType: "text/plain",
    }),
  );
  try {
    const r = await run(
      [
        "workspace",
        "file",
        "read",
        "--workspace-id",
        "w",
        "--path",
        "a",
        "--raw",
      ],
      auth(host),
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "文本\n");
    assert.equal(signed.requests[0].headers["x-api-key"], undefined);
    assert.equal(signed.requests[0].headers.authorization, undefined);
    const b = await run(
      ["workspace", "file", "read", "--workspace-id", "w", "--path", "binary"],
      auth(host),
    );
    assert.equal(b.code, 2);
  } finally {
    await host.close();
    await signed.close();
  }
});
test("Skill entry protection precedes same-path rename; ordinary same-path checks source without mutation", async () => {
  const f = await fixture((req, res) => json(res, { path: "a", content: "x" }));
  try {
    const protect = await run(
      [
        "skill",
        "file",
        "rename",
        "--skill-id",
        "s",
        "--path",
        "SKILL.md",
        "--to",
        "SKILL.md",
      ],
      auth(f),
    );
    assert.equal(protect.code, 2);
    assert.equal(protect.error().subtype, "protected_skill_entry");
    assert.equal(f.requests.length, 0);
    const same = await run(
      [
        "skill",
        "file",
        "rename",
        "--skill-id",
        "s",
        "--path",
        "a",
        "--to",
        "a",
      ],
      auth(f),
    );
    assert.equal(same.code, 0, same.stderr);
    assert.deepEqual(same.data().data, {
      type: "skill_file_renamed",
      id: "s",
      from: "a",
      to: "a",
    });
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].method, "GET");
  } finally {
    await f.close();
  }
});
