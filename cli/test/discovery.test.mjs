import { test } from "node:test";
import assert from "node:assert/strict";
import { run, fixture, json, auth } from "./helpers.mjs";
test("schema and guide work offline and expose actual command metadata", async () => {
  const s = await run(["schema", "session", "send"]);
  assert.equal(s.code, 0, s.stderr);
  const data = s.data().data;
  assert.equal(data.path, "session send");
  assert.equal(data.flags["wait-timeout"].default, "2h");
  assert.ok(data.bodyFields.events);
  assert.ok(data.examples.length);
  const raw = await run(["guide", "read", "--name", "oma-cli", "--raw"]);
  assert.equal(raw.code, 0, raw.stderr);
  assert.match(raw.stdout, /# oma-cli/);
  for (const args of [
    ["schema", "--field", "x"],
    ["schema", "session", "send", "--all"],
    [
      "session",
      "send",
      "--session-id",
      "s",
      "--prompt",
      "hi",
      "--wait-timeout",
      "2h",
    ],
  ])
    assert.equal((await run(args)).code, 2);
});
test("doctor missing credentials still completes health and capability checks", async () => {
  const f = await fixture((req, res) =>
    json(res, req.url.endsWith("/health") ? { status: "ok" } : { paths: {} }),
  );
  try {
    const r = await run(["doctor", "--base-url", f.url]);
    assert.equal(r.code, 2, r.stderr);
    assert.ok(r.data().data.some((x) => x.name === "health"));
    assert.ok(
      r
        .data()
        .data.some((x) => x.name === "authentication" && x.status === "error"),
    );
    assert.equal(f.requests.length, 2);
  } finally {
    await f.close();
  }
});
