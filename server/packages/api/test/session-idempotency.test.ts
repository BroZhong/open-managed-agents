import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStores } from "@oma-server/store-memory";
import { createApp } from "../src/app.js";
import { EnvironmentService } from "../src/lib/environments.js";

async function setup() {
  const stores = createMemoryStores();
  const environments = new EnvironmentService(stores.environmentStore, "ab".repeat(32));
  const app = createApp({ ...stores, environmentService: environments });
  const keys = await Promise.all(["t1", "t2"].map(async (tenantId) => (await stores.apiKeyStore.create(tenantId, tenantId)).rawKey));
  const agents = await Promise.all(["t1", "t2"].map(tenantId => stores.agentStore.create({ tenantId, name: "Test", model: "m", system: "s", runtime: "mock" })));
  const call = async (body: unknown, key: string | null = "request-1", tenant = 0, target = app) => {
    const response = await target.request("/v1/sessions", {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": keys[tenant], ...(key === null ? {} : { "Idempotency-Key": key }) },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const environment = async (id: string) => {
    await stores.environmentStore.create({ id, owner: { ownerType: "tenant", tenantId: "t1" }, name: id, description: "", baseImage: "oma-base", initScript: "", env: [], encryptedSecrets: {} });
    await stores.environmentStore.buildNow(id, "registry.example/test@sha256:" + "c".repeat(64));
  };
  return { stores, app, agents, call, environments, environment };
}

beforeEach(() => vi.stubEnv("AUTH_DISABLED", "false"));
afterEach(() => vi.unstubAllEnvs());

describe("Session creation Idempotency-Key", () => {
  it("coalesces concurrent requests, including a retry through a new app, into one Session and Workspace", async () => {
    const { stores, agents, call, environments } = await setup();
    const results = await Promise.all(Array.from({ length: 12 }, () => call({ agent: agents[0].id })));
    expect(results.every(r => r.status === 201)).toBe(true);
    expect(new Set(results.map(r => r.body.id)).size).toBe(1);
    expect((await stores.sessionStore.list("t1")).data).toHaveLength(1);
    expect(await stores.workspaceStore.list("t1")).toHaveLength(1);
    const replay = await call({ agent: agents[0].id }, "request-1", 0, createApp({ ...stores, environmentService: environments }));
    expect(replay).toEqual(results[0]);
  });

  it("returns 409 with the existing Session ID for each changed parameter, without allocating resources", async () => {
    const { stores, agents, call } = await setup();
    const input = { agent: agents[0].id };
    const first = await call(input);
    for (const changed of [{ agent: "agent_other" }, { workspace_id: "other" }, { workspace_name: "other" }, { environmentId: "env_other" }]) {
      expect(await call({ ...input, ...changed })).toMatchObject({ status: 409, body: { code: "idempotency_key_conflict", sessionId: first.body.id } });
    }
    expect((await stores.sessionStore.list("t1")).data).toHaveLength(1);
    expect(await stores.workspaceStore.list("t1")).toHaveLength(1);
  });

  it("normalizes aliases and preserves omitted Environment across Agent edits and deletion", async () => {
    const { stores, agents, call, environment } = await setup();
    await environment("env_a");
    await environment("env_b");
    await stores.agentStore.update(agents[0].id, { environmentId: "env_a" });
    const body = { agent: agents[0].id, workspace_id: "shared", workspace_name: "First" };
    const first = await call(body);
    expect(first.status).toBe(201);
    await stores.agentStore.update(agents[0].id, { environmentId: "env_b" });
    const replay = await call({ agent: agents[0].id, workspaceId: "shared", workspaceName: "First" });
    expect(replay).toEqual(first);
    expect((await stores.sessionStore.getById(first.body.id))?.environmentId).toBe("env_a");
    expect((await call({ ...body, environmentId: "env_a" })).status).toBe(409);
    const explicit = await call({ ...body, environmentId: "env_b" }, "explicit");
    expect(await call({ ...body, environment_id: "env_b" }, "explicit")).toEqual(explicit);
    await stores.agentStore.delete(agents[0].id);
    expect(await call(body)).toEqual(first);
  });

  it("isolates tenants and keys, while requests without keys still create fresh Sessions", async () => {
    const { stores, agents, call } = await setup();
    const a = await call({ agent: agents[0].id });
    const b = await call({ agent: agents[1].id }, "request-1", 1);
    expect(b.status).toBe(201);
    expect(b.body.id).not.toBe(a.body.id);
    const c = await call({ agent: agents[0].id }, "another-key");
    expect(c.body.id).not.toBe(a.body.id);
    for (let i = 0; i < 2; i++) {
      expect((await call({ agent: agents[0].id }, null)).status).toBe(201);
    }
    expect((await stores.sessionStore.list("t1")).data).toHaveLength(4);
  });

  it("replays current status and retains the key after termination and soft deletion", async () => {
    const { stores, agents, call } = await setup();
    const input = { agent: agents[0].id };
    const first = await call(input);
    await stores.sessionStore.terminate(first.body.id);
    await stores.sessionStore.softDelete(first.body.id);
    await stores.workspaceStore.softDelete("t1", first.body.workspaceId);
    const replay = await call(input);
    expect(replay).toMatchObject({ status: 201, body: { id: first.body.id, status: "terminated" } });
    expect((await call({ ...input, workspace_name: "new" })).status).toBe(409);
    expect(await stores.workspaceStore.list("t1", true)).toHaveLength(1);
  });

  it("does not consume a key on validation or creation failure and rolls back an auto-created Workspace", async () => {
    const { stores, agents, call } = await setup();
    expect((await call({ agent: "missing" })).status).toBe(404);
    const create = vi.spyOn(stores.sessionStore, "create").mockRejectedValueOnce(new Error("injected failure"));
    expect((await call({ agent: agents[0].id })).status).toBe(500);
    expect(await stores.workspaceStore.list("t1")).toHaveLength(0);
    create.mockRestore();
    expect((await call({ agent: agents[0].id })).status).toBe(201);
  });

  it("does not consume keys for a deleted Workspace or unready Environment", async () => {
    const { stores, agents, call } = await setup();
    await stores.workspaceStore.create({ tenantId: "t1", id: "deleted" });
    await stores.workspaceStore.softDelete("t1", "deleted");
    expect((await call({ agent: agents[0].id, workspace_id: "deleted" })).status).toBe(409);
    expect((await call({ agent: agents[0].id, environmentId: "missing" })).status).toBe(404);
    await stores.environmentStore.create({ id: "env_pending", owner: { ownerType: "tenant", tenantId: "t1" }, name: "pending", description: "", baseImage: "oma-base", initScript: "", env: [], encryptedSecrets: {} });
    expect((await call({ agent: agents[0].id, environmentId: "env_pending" })).status).toBe(409);
    expect((await call({ agent: agents[0].id })).status).toBe(201);
  });

  it.each(["", "a b", "a".repeat(129), "é"])("rejects invalid header %j before creating resources", async key => {
    const { stores, agents, call } = await setup();
    expect((await call({ agent: agents[0].id }, key)).status).toBe(400);
    expect(await stores.workspaceStore.list("t1")).toHaveLength(0);
  });
});
