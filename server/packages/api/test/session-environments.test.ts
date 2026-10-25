import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStores } from "@oma-server/store-memory";
import { createApp } from "../src/app.js";
import { EnvironmentService } from "../src/lib/environments.js";

const KEY = "ab".repeat(32);
const IMAGE = "registry.example/welltop/oma-environments@sha256:" + "c".repeat(64);
const agentBody = { name: "Bound", model: "m", system: "s", runtime: "pi-agent" };

/**
 * Agents bound to Environments and Sessions frozen to them (ADR-0024, "The
 * resource" and "Starting a Sandbox"), through the API: a built-in and a
 * Tenant Environment that are ready, and one still pending its first build.
 */
async function setup(options: { builtInImage?: boolean } = {}) {
  const stores = createMemoryStores();
  const environments = new EnvironmentService(stores.environmentStore, KEY, {
    inUse: (tenantId, id) => stores.agentStore.usesEnvironment(tenantId, id),
  });
  const app = createApp({
    apiKeyStore: stores.apiKeyStore, environmentService: environments,
    agentStore: stores.agentStore, agentFileStore: stores.agentFileStore, skillStore: stores.skillStore, skillBundleStore: stores.skillBundleStore,
    sessionStore: stores.sessionStore, workspaceStore: stores.workspaceStore, loopStore: stores.loopStore,
  });
  const keys = {
    t1: (await stores.apiKeyStore.create("t1", "t1")).rawKey,
    t2: (await stores.apiKeyStore.create("t2", "t2")).rawKey,
  };
  const call = async (method: string, path: string, body?: unknown, tenant: keyof typeof keys = "t1") => {
    const response = await app.request(path, {
      method,
      headers: { "x-api-key": keys[tenant], ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  const environment = async (owner: "platform" | "t1" | "t2", name: string, ready = true) => {
    const env = await stores.environmentStore.create({
      id: owner === "platform" ? `env_${name.replaceAll("-", "_")}` : `env_${owner}_${name}`,
      owner: owner === "platform" ? { ownerType: "platform" } : { ownerType: "tenant", tenantId: owner },
      name, description: "", baseImage: "oma-media", initScript: "true\n", env: [], encryptedSecrets: {},
    });
    if (ready) await stores.environmentStore.buildNow(env.id, IMAGE);
    return env;
  };
  const builtIn = await environment("platform", "video-production", options.builtInImage !== false);
  const own = await environment("t1", "tools");
  const pending = await environment("t1", "unbuilt", false);
  const foreign = await environment("t2", "theirs");
  return { stores, app, call, builtIn, own, pending, foreign, environment };
}

describe("Agents bound to an Environment (ADR-0024)", () => {
  beforeEach(() => { vi.unstubAllEnvs(); vi.stubEnv("AUTH_DISABLED", "false"); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("binds a ready Environment at creation or update and keeps it across edits", async () => {
    const { call, builtIn, own } = await setup();
    const created = await call("POST", "/v1/agents", { ...agentBody, environmentId: own.id });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ environmentId: own.id });
    expect((await call("GET", `/v1/agents/${created.body.id}`)).body).toMatchObject({ environmentId: own.id });
    const rebound = await call("POST", `/v1/agents/${created.body.id}`, { environmentId: builtIn.id });
    expect(rebound).toMatchObject({ status: 200, body: { environmentId: builtIn.id } });
    expect((await call("POST", `/v1/agents/${created.body.id}`, { name: "Renamed" })).body).toMatchObject({ name: "Renamed", environmentId: builtIn.id });
  });

  it("binds a Sandboxed Agent that names none to video-production, and refuses to leave it without one", async () => {
    const { call, builtIn } = await setup();
    for (const sandbox of [undefined, { enabled: true }]) {
      const created = await call("POST", "/v1/agents", { ...agentBody, ...(sandbox ? { sandbox } : {}) });
      expect(created).toMatchObject({ status: 201, body: { environmentId: builtIn.id } });
      expect(await call("POST", `/v1/agents/${created.body.id}`, { environmentId: null }))
        .toMatchObject({ status: 400, body: { code: "environment_required" } });
    }
    expect(await call("POST", "/v1/agents", { ...agentBody, environmentId: null })).toMatchObject({ status: 400, body: { code: "environment_required" } });
    // An Agent without a Sandbox has none unless it names one, and may drop it.
    const plain = await call("POST", "/v1/agents", { ...agentBody, sandbox: { enabled: false } });
    expect(plain.status).toBe(201);
    expect(plain.body).not.toHaveProperty("environmentId");
    expect((await call("POST", `/v1/agents/${plain.body.id}`, { environmentId: builtIn.id })).body).toMatchObject({ environmentId: builtIn.id });
    const unbound = await call("POST", `/v1/agents/${plain.body.id}`, { environmentId: null });
    expect(unbound.status).toBe(200);
    expect(unbound.body).not.toHaveProperty("environmentId");
    // Turning its Sandbox on binds the default.
    expect((await call("POST", `/v1/agents/${plain.body.id}`, { sandbox: { enabled: true } })).body).toMatchObject({ environmentId: builtIn.id });
  });

  it("refuses sandbox.image and sandbox.env, which Environments replaced, with their codes", async () => {
    const { call } = await setup();
    const agent = (await call("POST", "/v1/agents", agentBody)).body;
    for (const [sandbox, code] of [
      [{ enabled: true, image: "auto-story-v2" }, "sandbox_image_removed"],
      [{ enabled: true, env: { VFS_TOKEN: "private-sentinel" } }, "sandbox_env_removed"],
    ] as const) {
      const created = await call("POST", "/v1/agents", { ...agentBody, sandbox });
      expect(created).toMatchObject({ status: 400, body: { code } });
      expect(JSON.stringify(created.body)).not.toContain("private-sentinel");
      expect(await call("POST", `/v1/agents/${agent.id}`, { sandbox })).toMatchObject({ status: 400, body: { code } });
    }
    expect((await call("GET", `/v1/agents/${agent.id}`)).body.sandbox).toBeUndefined();
  });

  it("refuses an Environment that is not ready (409), not visible to the Tenant or deleted (404), or not an id (400)", async () => {
    const { call, own, pending, foreign } = await setup();
    const notReady = await call("POST", "/v1/agents", { ...agentBody, environmentId: pending.id });
    expect(notReady).toMatchObject({ status: 409, body: { code: "environment_not_ready" } });
    expect(await call("POST", "/v1/agents", { ...agentBody, environmentId: foreign.id })).toMatchObject({ status: 404, body: { code: "environment_not_found" } });
    expect(await call("POST", "/v1/agents", { ...agentBody, environmentId: 7 })).toMatchObject({ status: 400 });
    const agent = (await call("POST", "/v1/agents", agentBody)).body;
    expect(await call("POST", `/v1/agents/${agent.id}`, { environmentId: pending.id })).toMatchObject({ status: 409, body: { code: "environment_not_ready" } });
    expect(await call("DELETE", `/v1/environments/${own.id}`)).toMatchObject({ status: 200 });
    expect(await call("POST", `/v1/agents/${agent.id}`, { environmentId: own.id })).toMatchObject({ status: 404, body: { code: "environment_not_found" } });
    expect((await call("GET", `/v1/agents/${agent.id}`)).body).toMatchObject({ environmentId: "env_video_production" });
  });

  it("binds and runs Sessions in an Environment that serves an image whatever its rebuild: building, or failed (ADR-0024)", async () => {
    const { stores, call, own } = await setup();
    // A rebuild is queued, then one fails: the Environment keeps serving its image.
    expect(await call("POST", `/v1/environments/${own.id}`, { initScript: "apt-get install -y jq\n" })).toMatchObject({ body: { status: "pending" } });
    const agent = await call("POST", "/v1/agents", { ...agentBody, environmentId: own.id });
    expect(agent).toMatchObject({ status: 201, body: { environmentId: own.id } });
    for (let claimed; (claimed = await stores.environmentStore.claimBuild("builder", 60_000));) {
      if (claimed.build.environmentId === own.id) {
        expect(await stores.environmentStore.failBuild(claimed.lease, { code: "script_failed", message: "exit 1" })).toBe(true);
        break;
      }
    }
    expect((await call("GET", `/v1/environments/${own.id}`)).body).toMatchObject({ status: "failed", image: IMAGE });
    expect(await call("POST", "/v1/sessions", { agent: agent.body.id, environmentId: own.id })).toMatchObject({ status: 201, body: { environment: { id: own.id } } });
    expect(await call("POST", `/v1/agents/${agent.body.id}`, { name: "Again", environmentId: own.id })).toMatchObject({ status: 200 });
  });

  it("refuses to save a Sandboxed Agent without an Environment when video-production serves no image or does not exist", async () => {
    const { stores, call, builtIn } = await setup();
    await stores.environmentStore.update({ ownerType: "platform" }, builtIn.id, { initScript: "true\n# changed\n" });
    // Still serving its image while it rebuilds: the default binds.
    expect(await call("POST", "/v1/agents", agentBody)).toMatchObject({ status: 201, body: { environmentId: builtIn.id } });
    await stores.environmentStore.delete({ ownerType: "platform" }, builtIn.id);
    expect(await call("POST", "/v1/agents", agentBody)).toMatchObject({ status: 409, body: { code: "environment_not_ready" } });
    // An Agent without a Sandbox needs none.
    expect(await call("POST", "/v1/agents", { ...agentBody, sandbox: { enabled: false } })).toMatchObject({ status: 201 });
  });

  it("refuses a built-in default that never built", async () => {
    const { stores, call } = await setup({ builtInImage: false });
    expect((await stores.environmentStore.get("t1", "env_video_production"))?.image).toBeNull();
    expect(await call("POST", "/v1/agents", agentBody)).toMatchObject({ status: 409, body: { code: "environment_not_ready" } });
  });

  it("keeps an Agent's Environment while it rebuilds: an edit that resends it is not a new binding", async () => {
    const { call, own } = await setup();
    const agent = (await call("POST", "/v1/agents", { ...agentBody, environmentId: own.id })).body;
    expect(await call("POST", `/v1/environments/${own.id}`, { initScript: "apt-get install -y jq\n" })).toMatchObject({ body: { status: "pending" } });
    const edited = await call("POST", `/v1/agents/${agent.id}`, { ...agentBody, name: "Edited", environmentId: own.id });
    expect(edited).toMatchObject({ status: 200, body: { name: "Edited", environmentId: own.id } });
  });

  it("refuses to delete an Environment an Agent references (409 environment_in_use) until it is unbound", async () => {
    const { call, own } = await setup();
    const agent = (await call("POST", "/v1/agents", { ...agentBody, environmentId: own.id })).body;
    expect(await call("DELETE", `/v1/environments/${own.id}`)).toMatchObject({ status: 409, body: { code: "environment_in_use" } });
    await call("POST", `/v1/agents/${agent.id}`, { environmentId: "env_video_production" });
    expect(await call("DELETE", `/v1/environments/${own.id}`)).toMatchObject({ status: 200, body: { type: "environment_deleted" } });
  });

  it("carries the Environment into a fork", async () => {
    const { call, own } = await setup();
    const agent = (await call("POST", "/v1/agents", { ...agentBody, environmentId: own.id })).body;
    const fork = await call("POST", `/v1/agents/${agent.id}/fork`, { name: "Copy" });
    expect(fork).toMatchObject({ status: 201, body: { name: "Copy", environmentId: own.id } });
  });
});

describe("Sessions frozen to an Environment (ADR-0024)", () => {
  beforeEach(() => { vi.unstubAllEnvs(); vi.stubEnv("AUTH_DISABLED", "false"); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("runs a Session in its Agent's Environment as of its creation, and shows its id and current name", async () => {
    const { call, builtIn, own } = await setup();
    const agent = (await call("POST", "/v1/agents", { ...agentBody, environmentId: own.id })).body;
    const created = await call("POST", "/v1/sessions", { agent: agent.id });
    expect(created).toMatchObject({ status: 201, body: { environment: { id: own.id, name: "tools" } } });
    expect(created.body).not.toHaveProperty("environmentId");
    // Rebinding the Agent changes the Environment of its new Sessions only.
    await call("POST", `/v1/agents/${agent.id}`, { environmentId: builtIn.id });
    expect((await call("GET", `/v1/sessions/${created.body.id}`)).body).toMatchObject({ environment: { id: own.id, name: "tools" } });
    const later = await call("POST", "/v1/sessions", { agent: agent.id });
    expect(later.body.environment).toEqual({ id: builtIn.id, name: "video-production" });
    // A rename shows at once; a deleted Environment still names the Sessions frozen to it.
    await call("POST", `/v1/environments/${own.id}`, { name: "renamed" });
    expect((await call("GET", `/v1/sessions/${created.body.id}`)).body.environment).toEqual({ id: own.id, name: "renamed" });
    expect(await call("DELETE", `/v1/environments/${own.id}`)).toMatchObject({ status: 200 });
    expect((await call("GET", `/v1/sessions/${created.body.id}`)).body.environment).toEqual({ id: own.id, name: "renamed" });
    const listed = (await call("GET", "/v1/sessions")).body.data;
    expect(new Map(listed.map((session: { id: string; environment: unknown }) => [session.id, session.environment]))).toEqual(new Map([
      [created.body.id, { id: own.id, name: "renamed" }], [later.body.id, { id: builtIn.id, name: "video-production" }],
    ]));
  });

  it("overrides the Agent's Environment with environmentId or environment_id, which must be ready and visible", async () => {
    const { call, builtIn, own, pending, foreign } = await setup();
    const agent = (await call("POST", "/v1/agents", { ...agentBody, environmentId: own.id })).body;
    const camel = await call("POST", "/v1/sessions", { agent: agent.id, environmentId: builtIn.id });
    expect(camel).toMatchObject({ status: 201, body: { environment: { id: builtIn.id, name: "video-production" } } });
    const snake = await call("POST", "/v1/sessions", { agent: agent.id, environment_id: builtIn.id });
    expect(snake.body.environment).toEqual({ id: builtIn.id, name: "video-production" });
    expect(await call("POST", "/v1/sessions", { agent: agent.id, environmentId: pending.id })).toMatchObject({ status: 409, body: { code: "environment_not_ready" } });
    expect(await call("POST", "/v1/sessions", { agent: agent.id, environment_id: foreign.id })).toMatchObject({ status: 404, body: { code: "environment_not_found" } });
    expect(await call("POST", "/v1/sessions", { agent: agent.id, environmentId: null })).toMatchObject({ status: 400 });
    // Refused creations create nothing.
    expect((await call("GET", "/v1/sessions")).body.data).toHaveLength(2);
  });

  it("runs a Session of an Agent without a Sandbox in no Environment", async () => {
    const { call } = await setup();
    const agent = (await call("POST", "/v1/agents", { ...agentBody, sandbox: { enabled: false } })).body;
    const created = await call("POST", "/v1/sessions", { agent: agent.id });
    expect(created).toMatchObject({ status: 201, body: { environment: null } });
    expect((await call("GET", `/v1/sessions/${created.body.id}`)).body.environment).toBeNull();
    expect((await call("POST", `/v1/sessions/${created.body.id}`, { title: "Renamed" })).body).toMatchObject({ title: "Renamed", environment: null });
  });

  it("runs a Loop's Session in its Agent's Environment at trigger time", async () => {
    const { call, builtIn, own } = await setup();
    const agent = (await call("POST", "/v1/agents", { ...agentBody, environmentId: own.id })).body;
    const loop = (await call("POST", `/v1/agents/${agent.id}/loops`, { name: "Review", prompt: "Review.", intervalMinutes: 5, enabled: false })).body;
    expect((await call("POST", `/v1/loops/${loop.id}/run`)).body.environment).toEqual({ id: own.id, name: "tools" });
    await call("POST", `/v1/agents/${agent.id}`, { environmentId: builtIn.id });
    expect((await call("POST", `/v1/loops/${loop.id}/run`)).body.environment).toEqual({ id: builtIn.id, name: "video-production" });
  });
});
