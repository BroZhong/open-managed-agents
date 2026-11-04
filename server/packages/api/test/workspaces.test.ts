import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  afterEach(() => vi.useRealTimers());

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

  it("discovers named Workspaces independently for each Agent and Tenant", async () => {
    const { app, stores } = createTestApp();
    const input = { name: "Agent", model: "claude-3", system: "sys", runtime: "mock" as const };
    const firstAgent = await stores.agentStore.create({ ...input, tenantId: "dev" });
    const secondAgent = await stores.agentStore.create({ ...input, tenantId: "dev" });
    const foreignAgent = await stores.agentStore.create({ ...input, tenantId: "other" });

    for (const [id, agent] of [["first", firstAgent], ["second", secondAgent], ["foreign", foreignAgent]] as const) {
      await stores.workspaceStore.create({ tenantId: agent.tenantId, id, name: id });
      await stores.sessionStore.create({ tenantId: agent.tenantId, agentId: agent.id, agent, workspaceId: id });
    }
    await stores.workspaceStore.create({ tenantId: "dev", id: "empty", name: "Unused" });

    for (const [agentId, expected] of [[firstAgent.id, ["first"]], [secondAgent.id, ["second"]], [foreignAgent.id, []], ["missing", []]] as const) {
      const res = await app.request(`/v1/workspaces?agent_id=${agentId}`);
      expect(res.status).toBe(200);
      expect((await res.json()).data.map((workspace: { id: string }) => workspace.id)).toEqual(expected);
    }
  });

  it("orders Workspaces by their latest visible Session update and moves an older running Workspace to the top", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
    const { app, stores } = createTestApp();
    const input = { tenantId: "dev", name: "Agent", model: "claude-3", system: "sys", runtime: "mock" as const };
    const agent = await stores.agentStore.create(input);
    const other = await stores.agentStore.create(input);
    const createSession = (workspaceId: string) => stores.sessionStore.create({ ...input, agentId: agent.id, agent, workspaceId });
    await stores.workspaceStore.create({ tenantId: "dev", id: "old", name: "Old" });
    await createSession("old");
    const resumed = await createSession("old");

    vi.setSystemTime(new Date("2026-11-02T00:00:00Z"));
    for (const id of ["new_a", "new_z"]) {
      await stores.workspaceStore.create({ tenantId: "dev", id, name: id });
      await createSession(id);
    }
    const list = async () => {
      const response = await app.request(`/v1/workspaces?agent_id=${agent.id}`);
      expect(response.status).toBe(200);
      return (await response.json()).data as { id: string; updatedAt: string; hasRunningSessions: boolean }[];
    };
    expect((await list()).map((workspace) => workspace.id)).toEqual(["new_z", "new_a", "old"]);

    vi.setSystemTime(new Date("2026-11-03T00:00:00Z"));
    await stores.sessionStore.updateStatus(resumed.id, "running");
    const updated = await list();
    expect(updated.map((workspace) => workspace.id)).toEqual(["old", "new_z", "new_a"]);
    expect(updated[0]).toMatchObject({ updatedAt: "2026-11-03T00:00:00.000Z", hasRunningSessions: true });

    vi.setSystemTime(new Date("2026-11-04T00:00:00Z"));
    for (const kind of ["other", "loop", "child", "deleted"]) {
      const owner = kind === "other" ? other : agent;
      const session = await stores.sessionStore.create({
        tenantId: "dev", agentId: owner.id, agent: owner, workspaceId: "new_a",
        loopId: kind === "loop" ? "loop" : undefined,
        delegation: kind === "child" ? { parentSessionId: resumed.id, parentTurnId: "turn", parentToolUseId: "tool", sandboxSessionId: resumed.id } : undefined,
      });
      await stores.sessionStore.updateStatus(session.id, "running");
      if (kind === "deleted") await stores.sessionStore.softDelete(session.id);
    }
    expect(await list()).toEqual(updated);

    await createSession("new_a");
    expect((await list()).map((workspace) => workspace.id)).toEqual(["new_a", "old", "new_z"]);
  });

  it("excludes unnamed, deleted, Loop-only and delegated-only Workspaces from Agent discovery", async () => {
    const { app, stores } = createTestApp();
    const agent = await stores.agentStore.create({ tenantId: "dev", name: "Agent", model: "claude-3", system: "sys", runtime: "mock" });
    for (const id of ["visible", "unnamed", "empty_name", "deleted_workspace", "deleted_session", "loop_only", "child_only"]) {
      await stores.workspaceStore.create({
        tenantId: "dev",
        id,
        name: id === "unnamed" ? undefined : id === "empty_name" ? "" : id,
      });
      const session = await stores.sessionStore.create({
        tenantId: "dev",
        agentId: agent.id,
        agent,
        workspaceId: id,
        loopId: id === "loop_only" ? "loop_test" : undefined,
        delegation: id === "child_only" ? {
          parentSessionId: "sess_parent",
          parentTurnId: "turn_parent",
          parentToolUseId: "tool_child",
          sandboxSessionId: "sess_parent",
        } : undefined,
      });
      if (id === "deleted_workspace") await stores.workspaceStore.softDelete("dev", id);
      if (id === "deleted_session") await stores.sessionStore.softDelete(session.id);
    }

    const res = await app.request(`/v1/workspaces?agent_id=${agent.id}`);
    expect(res.status).toBe(200);
    expect((await res.json()).data.map((workspace: { id: string }) => workspace.id)).toEqual(["visible"]);
  });

  it("summarizes activity beyond loaded pages and excludes other Agents, Loops, children and deleted Sessions", async () => {
    const { app, stores } = createTestApp();
    const input = { tenantId: "dev", name: "Agent", model: "claude-3", system: "sys", runtime: "mock" as const };
    const agent = await stores.agentStore.create(input);
    const other = await stores.agentStore.create(input);
    await stores.workspaceStore.create({ tenantId: "dev", id: "project", name: "Project" });
    for (let index = 0; index < 6; index++) {
      await stores.sessionStore.create({ tenantId: "dev", agentId: agent.id, agent, workspaceId: "project" });
    }
    const active = await stores.sessionStore.create({ tenantId: "dev", agentId: agent.id, agent, workspaceId: "project" });
    for (const kind of ["other", "loop", "child", "deleted"]) {
      const owner = kind === "other" ? other : agent;
      const session = await stores.sessionStore.create({
        tenantId: "dev", agentId: owner.id, agent: owner, workspaceId: "project",
        loopId: kind === "loop" ? "loop" : undefined,
        delegation: kind === "child" ? { parentSessionId: active.id, parentTurnId: "turn", parentToolUseId: "tool", sandboxSessionId: active.id } : undefined,
      });
      await stores.sessionStore.updateStatus(session.id, "running");
      if (kind === "deleted") await stores.sessionStore.softDelete(session.id);
    }
    for (const status of ["running", "waiting", "idle", "terminated"] as const) {
      await stores.sessionStore.updateStatus(active.id, status);
      const response = await app.request(`/v1/workspaces?agent_id=${agent.id}`);
      expect((await response.json()).data).toEqual([expect.objectContaining({
        id: "project", hasRunningSessions: status === "running" || status === "waiting",
      })]);
    }
  });

  it("finds a Workspace whose Sessions are beyond the Agent's first page", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
    const { app, stores } = createTestApp();
    const agent = await stores.agentStore.create({ tenantId: "dev", name: "Agent", model: "claude-3", system: "sys", runtime: "mock" });
    await stores.workspaceStore.create({ tenantId: "dev", id: "early", name: "Early" });
    await stores.workspaceStore.create({ tenantId: "dev", id: "later", name: "Later" });
    for (let index = 0; index < 55; index++) {
      await stores.sessionStore.create({ tenantId: "dev", agentId: agent.id, agent, workspaceId: "early" });
    }
    vi.setSystemTime(new Date("2026-11-02T00:00:00Z"));
    await stores.sessionStore.create({ tenantId: "dev", agentId: agent.id, agent, workspaceId: "later" });
    const firstPage = await stores.sessionStore.list("dev", { agentId: agent.id });
    expect(firstPage.data).toHaveLength(50);
    expect(firstPage.data.every((session) => session.workspaceId === "early")).toBe(true);

    const res = await app.request(`/v1/workspaces?agent_id=${agent.id}`);
    expect(res.status).toBe(200);
    expect((await res.json()).data.map((workspace: { id: string }) => workspace.id)).toEqual(["later", "early"]);
  });

  it("paginates Agent Workspaces by recency with an independent, stable cursor", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
    const { app, stores } = createTestApp();
    const agent = await stores.agentStore.create({ tenantId: "dev", name: "Agent", model: "claude-3", system: "sys", runtime: "mock" });
    for (let index = 0; index < 28; index++) {
      const id = `workspace_${String(index).padStart(2, "0")}`;
      await stores.workspaceStore.create({ tenantId: "dev", id, name: id });
      await stores.sessionStore.create({ tenantId: "dev", agentId: agent.id, agent, workspaceId: id });
    }
    const list = async (limit: number, cursor?: string) => {
      const params = new URLSearchParams({ agent_id: agent.id, limit: String(limit) });
      if (cursor) params.set("cursor", cursor);
      const response = await app.request(`/v1/workspaces?${params}`);
      expect(response.status).toBe(200);
      return response.json();
    };
    const first = await list(5);
    expect(first.data.map((w: { id: string }) => w.id)).toEqual(["workspace_27", "workspace_26", "workspace_25", "workspace_24", "workspace_23"]);
    expect(first.has_more).toBe(true);
    // Deleting the boundary row must not invalidate its timestamp/ID cursor.
    await stores.workspaceStore.softDelete("dev", "workspace_23");
    const second = await list(20, first.next_cursor);
    expect(second.data).toHaveLength(20);
    expect(second.data[0].id).toBe("workspace_22");
    expect(second.has_more).toBe(true);
    const last = await list(20, second.next_cursor);
    expect(last.data.map((w: { id: string }) => w.id)).toEqual(["workspace_02", "workspace_01", "workspace_00"]);
    expect(last.has_more).toBe(false);
    expect(last.next_cursor).toBeUndefined();
    expect(new Set([...first.data, ...second.data, ...last.data].map((w) => w.id)).size).toBe(28);
  });

  it.each(["limit=0", "limit=101", "limit=abc", "limit=1.5", "cursor=bad", "cursor="])("rejects invalid Workspace pagination: %s", async (query) => {
    const { app } = createTestApp();
    expect((await app.request(`/v1/workspaces?agent_id=agent_test&${query}`)).status).toBe(400);
  });

  it("requires an Agent for Workspace pagination", async () => {
    const { app } = createTestApp();
    expect((await app.request("/v1/workspaces?limit=5")).status).toBe(400);
  });

  it("preserves unfiltered Workspace endpoints when no Session store is configured", async () => {
    const stores = createMemoryStores();
    const app = createApp({ apiKeyStore: makeApiKeyStore(), workspaceStore: stores.workspaceStore });
    await stores.workspaceStore.create({ tenantId: "dev", id: "named", name: "Named" });
    await stores.workspaceStore.create({ tenantId: "dev", id: "unnamed" });

    const res = await app.request("/v1/workspaces");
    expect(res.status).toBe(200);
    expect((await res.json()).data.map((workspace: { id: string }) => workspace.id)).toEqual(["named", "unnamed"]);
    const scoped = await app.request("/v1/workspaces?agent_id=agent_test");
    expect(scoped.status).toBe(503);
  });

  it("rejects an empty Agent filter rather than listing another Agent's Workspaces", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/workspaces?agent_id=");
    expect(res.status).toBe(400);
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
      runtime: "mock",
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
