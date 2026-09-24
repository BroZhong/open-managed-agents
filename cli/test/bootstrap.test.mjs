import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, json, run, auth } from "./helpers.mjs";
test("agent discovery summarizes a page, preserves full configuration on get and deployment prefix", async () => {
  const agent = {
    id: "a1",
    name: "Agent",
    runtime: "mock",
    model: "m",
    system: "instructions",
    sandbox: { enabled: true },
  };
  const f = await fixture((req, res) =>
    json(
      res,
      req.url.includes("/a1") ? agent : { data: [agent], has_more: false },
    ),
  );
  try {
    const list = await run(["agent", "list"], auth(f));
    assert.equal(list.code, 0, list.stderr);
    assert.deepEqual(list.data(), {
      ok: true,
      command: "agent list",
      data: [{ id: "a1", name: "Agent", runtime: "mock", model: "m" }],
      meta: { has_more: false },
    });
    assert.equal(f.requests[0].url, "/prefix/v1/agents?limit=50");
    assert.equal(f.requests[0].headers["x-api-key"], "test-secret");
    const get = await run(["agent", "get", "--agent-id", "a1"], auth(f));
    assert.deepEqual(get.data().data, agent);
  } finally {
    await f.close();
  }
});
