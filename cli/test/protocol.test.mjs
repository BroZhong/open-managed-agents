import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, json, run, auth } from "./helpers.mjs";
test("validation is offline, body duplicates fail, raw preserves bytes and dry-run never writes", async () => {
  const f = await fixture((req, res) =>
    json(res, { filename: "SOUL", content: "你好\n\n", updatedAt: "now" }),
  );
  try {
    for (const args of [
      ["agent", "list", "--limit", "1.5"],
      ["agent", "list", "--dry-run"],
      ["agent", "get"],
      ["agent", "create", "--body", '{"sandbox":{}}'],
      [
        "agent",
        "update",
        "--agent-id",
        "a",
        "--name",
        "x",
        "--body",
        '{"name":"x"}',
      ],
      [
        "agent",
        "file",
        "read",
        "--agent-id",
        "a",
        "--name",
        "SOUL",
        "--raw",
        "--format",
        "json",
      ],
    ]) {
      const r = await run(args, auth(f));
      assert.equal(r.code, 2, r.stderr);
    }
    assert.equal(f.requests.length, 0);
    const raw = await run(
      ["agent", "file", "read", "--agent-id", "a", "--name", "SOUL", "--raw"],
      auth(f),
    );
    assert.equal(raw.stdout, "你好\n\n");
    assert.equal(raw.code, 0, raw.stderr);
    const dry = await run(
      [
        "agent",
        "file",
        "delete",
        "--agent-id",
        "a",
        "--name",
        "SOUL",
        "--dry-run",
      ],
      auth(f),
    );
    assert.equal(dry.code, 10, dry.stderr);
    assert.equal(f.requests.length, 1);
    assert.equal(dry.data().data.steps[0].method, "DELETE");
  } finally {
    await f.close();
  }
});
test("non-JSON Host responses explain an invalid API base URL", async () => {
  const f = await fixture((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html></html>");
  });
  try {
    const r = await run(["agent", "list"], auth(f));
    assert.equal(r.code, 2);
    assert.equal(r.error().type, "validation");
    assert.equal(r.error().subtype, "non_json_response");
    assert.match(r.error().message, /Expected JSON response/);
    assert.match(r.error().hint, /OMA_BASE_URL/);
  } finally {
    await f.close();
  }
});
test("pagination, field and HTTP error classification", async () => {
  const f = await fixture((req, res) =>
    req.url.includes("/missing")
      ? json(res, { error: "Not found" }, 404)
      : json(res, {
          data: [
            {
              id: req.url.includes("cursor") ? "b" : "a",
              name: "n",
              runtime: "mock",
              model: "m",
            },
          ],
          has_more: !req.url.includes("cursor"),
          next_cursor: "a",
        }),
  );
  try {
    const all = await run(
      ["--api-key", "override", "agent", "list", "--all", "--field", "id"],
      auth(f),
    );
    assert.equal(all.stdout, "a\nb\n");
    assert.equal(f.requests[0].headers["x-api-key"], "override");
    const missing = await run(
      ["agent", "get", "--agent-id", "missing"],
      auth(f),
    );
    assert.equal(missing.code, 3);
    assert.equal(missing.stdout, "");
    assert.equal(missing.error().type, "not_found");
  } finally {
    await f.close();
  }
});

test("body sources, stdin exclusivity, protected fields and redacted plans use one public contract", async () => {
  const f = await fixture((req, res, body) =>
    json(res, { id: "a", ...JSON.parse(body || "{}") }, 201),
  );
  try {
    const r = await run(["agent", "create", "--body", "-"], {
      ...auth(f),
      input: JSON.stringify({
        name: "n",
        runtime: "mock",
        model: "m",
        system: "s",
      }),
    });
    assert.equal(r.code, 0, r.stderr);
    for (const args of [
      [
        "agent",
        "create",
        "--body",
        '{"name":"n","runtime":"mock","model":"m","system":"s","tools":[]}',
      ],
      [
        "agent",
        "file",
        "write",
        "--agent-id",
        "a",
        "--name",
        "MEMORY",
        "--file",
        "-",
        "--body",
        "-",
      ],
      ["workspace", "create", "--body", '{"id":"bad/id"}'],
      ["workspace", "create", "--body", '{"name":null}'],
      [
        "skill",
        "file",
        "write",
        "--skill-id",
        "s",
        "--path",
        "a",
        "--body",
        '{"path":"a","content":""}',
      ],
      [
        "session",
        "send",
        "--session-id",
        "s",
        "--body",
        '{"events":[{"type":"user.interrupt","data":{}}]}',
      ],
      [
        "session",
        "send",
        "--session-id",
        "s",
        "--body",
        '{"events":[{"type":"user.message","data":{"content":[]}}]}',
      ],
    ]) {
      const bad = await run(args, auth(f));
      assert.equal(bad.code, 2, bad.stderr);
    }
    assert.equal(f.requests.length, 1);
    const dry = await run(
      [
        "session",
        "send",
        "--session-id",
        "s",
        "--body",
        '{"events":[{"type":"user.message","data":{"text":"private-text"}}]}',
        "--dry-run",
      ],
      auth(f),
    );
    assert.equal(dry.code, 10);
    assert.ok(!dry.stdout.includes("private-text"));
    assert.equal(f.requests.length, 1);
  } finally {
    await f.close();
  }
});
test("writes are submitted once on lost response and HTTP timeout is distinct from validation", async () => {
  const f = await fixture((req, res) =>
    req.url.endsWith("/agents")
      ? req.socket.destroy()
      : setTimeout(() => json(res, { id: "a" }), 150),
  );
  try {
    const write = await run(
      [
        "agent",
        "create",
        "--name",
        "n",
        "--runtime",
        "mock",
        "--model",
        "m",
        "--system",
        "s",
      ],
      auth(f),
    );
    assert.equal(write.code, 1);
    assert.equal(f.requests.length, 1);
    assert.match(write.error().hint, /may have been accepted/);
    const timeout = await run(
      ["agent", "get", "--agent-id", "a", "--timeout", "40ms"],
      auth(f),
    );
    assert.equal(timeout.code, 124);
    assert.equal(timeout.error().subtype, "http_timeout");
  } finally {
    await f.close();
  }
});

test("empty equip body IDs and missing local upload input fail before networking", async () => {
  const f = await fixture((req, res) =>
    json(res, { error: "Should not contact Host" }, 401),
  );
  try {
    for (const args of [
      [
        "agent",
        "skill",
        "equip",
        "--agent-id",
        "a",
        "--body",
        '{"skillId":""}',
      ],
      [
        "agent",
        "skill",
        "equip",
        "--agent-id",
        "a",
        "--body",
        '{"skillId":""}',
        "--dry-run",
      ],
      [
        "workspace",
        "file",
        "upload",
        "--workspace-id",
        "w",
        "--path",
        "x",
        "--file",
        "/definitely/missing/oma-cli-file",
      ],
    ]) {
      const r = await run(args, auth(f));
      assert.ok([2, 3].includes(r.code), r.stderr);
    }
    assert.equal(f.requests.length, 0);
  } finally {
    await f.close();
  }
});
