import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, json, run, auth } from "./helpers.mjs";

/** A Host that answers Agent and Session writes like /v1, refusing an Environment that is not ready. */
const host = () =>
  fixture((req, res, body) => {
    const sent = body.length ? JSON.parse(body.toString()) : {};
    if ([sent.environmentId, sent.environment_id].includes("env_unbuilt"))
      return json(res, { error: "Environment unbuilt is pending; only a ready Environment can be bound", code: "environment_not_ready" }, 409);
    if (req.url.includes("/v1/sessions") && req.method === "GET")
      return json(res, { data: [{ id: "s1", title: "t", agentId: "a", workspaceId: "w", status: "idle", environment: { id: "env_1", name: "tools" }, agent: { name: "A" } }], has_more: false });
    if (req.url.includes("/v1/sessions"))
      return json(res, { id: "s1", agentId: sent.agent, environment: sent.environmentId ? { id: sent.environmentId, name: "tools" } : null }, 201);
    return json(res, { id: "a", name: "A", ...sent }, req.url.endsWith("/v1/agents") ? 201 : 200);
  });
const sent = (f, index = -1) => JSON.parse(f.requests.at(index).body.toString());

test("agent create and update bind an Environment with --environment; a new Agent that names none is the Host's to default", async () => {
  const f = await host();
  try {
    const created = await run(["agent", "create", "--name", "A", "--runtime", "pi-agent", "--model", "m", "--system", "s", "--environment", "env_1"], auth(f));
    assert.equal(created.code, 0, created.stderr);
    assert.deepEqual(sent(f), { name: "A", runtime: "pi-agent", model: "m", system: "s", environmentId: "env_1" });
    assert.equal(created.data().data.environmentId, "env_1");

    const rebound = await run(["agent", "update", "--agent-id", "a", "--environment", "env_video_production"], auth(f));
    assert.equal(rebound.code, 0, rebound.stderr);
    assert.equal(f.requests.at(-1).url, "/prefix/v1/agents/a");
    assert.deepEqual(sent(f), { environmentId: "env_video_production" });

    const defaulted = await run(["agent", "create", "--name", "B", "--runtime", "pi-agent", "--model", "m", "--system", "s"], auth(f));
    assert.equal(defaulted.code, 0, defaulted.stderr);
    assert.equal("environmentId" in sent(f), false);
  } finally {
    await f.close();
  }
});

test("agent update refuses an empty Environment, an unbinding and the removed sandbox fields before any request", async () => {
  const f = await host();
  try {
    for (const args of [
      ["--environment", ""],
      ["--no-environment"],
      ["--body", '{"environmentId":null}'],
      ["--body", '{"environmentId":7}'],
      ["--body", '{"sandbox":{"enabled":true,"env":{"A":"1"}}}'],
    ]) {
      const r = await run(["agent", "update", "--agent-id", "a", ...args], auth(f));
      assert.equal(r.code, 2, `${args.join(" ")}: ${r.stderr}`);
    }
    assert.equal(f.requests.length, 0);
  } finally {
    await f.close();
  }
});

test("an Environment that is not ready is a conflict naming environment_not_ready", async () => {
  const f = await host();
  try {
    const r = await run(["agent", "update", "--agent-id", "a", "--environment", "env_unbuilt"], auth(f));
    assert.equal(r.code, 5, r.stderr);
    assert.equal(r.error().subtype, "environment_not_ready");
    const s = await run(["session", "create", "--agent-id", "a", "--environment", "env_unbuilt"], auth(f));
    assert.equal(s.code, 5, s.stderr);
    assert.equal(s.error().subtype, "environment_not_ready");
  } finally {
    await f.close();
  }
});

test("session create overrides the Agent's Environment with --environment, and session list shows each Session's", async () => {
  const f = await host();
  try {
    const created = await run(["session", "create", "--agent-id", "a", "--environment", "env_1"], auth(f));
    assert.equal(created.code, 0, created.stderr);
    assert.deepEqual(sent(f), { agent: "a", environmentId: "env_1" });
    assert.deepEqual(created.data().data.environment, { id: "env_1", name: "tools" });
    const listed = await run(["session", "list"], auth(f));
    assert.equal(listed.code, 0, listed.stderr);
    assert.deepEqual(listed.data().data[0].environment, { id: "env_1", name: "tools" });
  } finally {
    await f.close();
  }
});
