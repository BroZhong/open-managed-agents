import { describe, it, expect, beforeEach } from "vitest";
import { createApp } from "../src/app.js";
import type { ApiKeyStore, TenantContext } from "../src/types.js";
import { createMemoryStores } from "@oma-server/store-memory";

function makeApiKeyStore(): ApiKeyStore {
  return {
    async findByKeyHash(): Promise<TenantContext | null> {
      return null;
    },
  };
}

function createTestApp() {
  process.env.AUTH_DISABLED = "true";
  const stores = createMemoryStores();
  const app = createApp({
    apiKeyStore: makeApiKeyStore(),
    agentStore: stores.agentStore,
    sessionStore: stores.sessionStore,
    workspaceStore: stores.workspaceStore,
  });
  return { app, stores };
}

describe("POST /v1/workspaces", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("creates a named Workspace", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Design Docs" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toMatch(/^ws_/);
    expect(body.name).toBe("Design Docs");
    expect(body.tenantId).toBe("dev");
  });

  it("uses a supplied id as-is and is idempotent (name not clobbered)", async () => {
    const { app } = createTestApp();
    const first = await (
      await app.request("/v1/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "shared", name: "First" }),
      })
    ).json();
    const second = await (
      await app.request("/v1/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "shared", name: "Second" }),
      })
    ).json();
    expect(first.id).toBe("shared");
    expect(second.id).toBe("shared");
    expect(second.name).toBe("First");
  });

  it("rejects a non-string name", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: 42 }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("name must be a string");
  });
});

describe("GET /v1/workspaces", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("lists the tenant's Workspaces", async () => {
    const { app, stores } = createTestApp();
    await stores.workspaceStore.create({ tenantId: "dev", id: "a", name: "A" });
    await stores.workspaceStore.create({ tenantId: "dev", id: "b", name: "B" });
    await stores.workspaceStore.create({ tenantId: "other", id: "c", name: "C" });

    const res = await app.request("/v1/workspaces");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((w: { id: string }) => w.id)).toEqual(["a", "b"]);
  });
});

describe("GET /v1/workspaces/:id", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("returns a Workspace by id", async () => {
    const { app, stores } = createTestApp();
    await stores.workspaceStore.create({ tenantId: "dev", id: "w1", name: "W1" });
    const res = await app.request("/v1/workspaces/w1");
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe("W1");
  });

  it("returns 404 for a Workspace in another tenant", async () => {
    const { app, stores } = createTestApp();
    await stores.workspaceStore.create({ tenantId: "other", id: "secret", name: "X" });
    const res = await app.request("/v1/workspaces/secret");
    expect(res.status).toBe(404);
  });

  it("returns 404 for a non-existent Workspace", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/workspaces/nope");
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/workspaces/:id (rename)", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("renames a Workspace", async () => {
    const { app, stores } = createTestApp();
    await stores.workspaceStore.create({ tenantId: "dev", id: "w1", name: "Old" });
    const res = await app.request("/v1/workspaces/w1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe("New");
    expect((await stores.workspaceStore.getById("dev", "w1"))?.name).toBe("New");
  });

  it("rejects a non-string name", async () => {
    const { app, stores } = createTestApp();
    await stores.workspaceStore.create({ tenantId: "dev", id: "w1", name: "Old" });
    const res = await app.request("/v1/workspaces/w1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: 42 }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("name must be a string");
  });

  it("returns 404 for a Workspace in another tenant", async () => {
    const { app, stores } = createTestApp();
    await stores.workspaceStore.create({ tenantId: "other", id: "secret", name: "X" });
    const res = await app.request("/v1/workspaces/secret", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "hijack" }),
    });
    expect(res.status).toBe(404);
    expect((await stores.workspaceStore.getById("other", "secret"))?.name).toBe("X");
  });

  it("returns 404 for a non-existent Workspace", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/workspaces/nope", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("Session mounts a named Workspace", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("binds an existing named Workspace so two sessions share one workspaceId (same S3 prefix)", async () => {
    const { app, stores } = createTestApp();
    const agent = await stores.agentStore.create({
      tenantId: "dev",
      name: "Agent",
      model: "claude-3",
      system: "sys",
      runtime: "claude-code",
    });

    // Create a named Workspace up front.
    const ws = await (
      await app.request("/v1/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Team Space" }),
      })
    ).json();

    const mk = () =>
      app.request("/v1/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: agent.id, workspace_id: ws.id }),
      });

    const s1 = await (await mk()).json();
    const s2 = await (await mk()).json();

    // Same workspaceId => same <tenantId>/<workspaceId>/ S3 prefix => shared files.
    expect(s1.workspaceId).toBe(ws.id);
    expect(s2.workspaceId).toBe(ws.id);
    expect(s1.id).not.toBe(s2.id);

    // Only one Workspace entity exists for the shared id.
    const list = await (await app.request("/v1/workspaces")).json();
    expect(list.data.filter((w: { id: string }) => w.id === ws.id)).toHaveLength(1);
  });
});
