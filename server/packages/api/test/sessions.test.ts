import { describe, it, expect, beforeEach } from "vitest";
import { createApp } from "../src/app.js";
import { InMemoryEventLogStore, InMemorySessionStore } from "@oma-server/store-memory";
import type { ApiKeyStore, TenantContext } from "../src/types.js";
import type {
  AgentStore,
  Agent,
  AgentStoreCreateInput,
  AgentStoreUpdateInput,
  AgentStoreListOpts,
  PaginatedResult,
  WorkspaceMetadataStore,
  WorkspaceMetadataStoreCreateInput,
  Workspace,
} from "@oma-server/store";

// In-memory AgentStore for testing
class InMemoryAgentStore implements AgentStore {
  private agents: Agent[] = [];
  private nextId = 1;

  async create(input: AgentStoreCreateInput): Promise<Agent> {
    const agent: Agent = {
      id: `agent_${this.nextId++}`,
      tenantId: input.tenantId,
      name: input.name,
      model: input.model,
      system: input.system,
      runtime: input.runtime,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.agents.push(agent);
    return agent;
  }

  async getById(id: string): Promise<Agent | null> {
    return this.agents.find((a) => a.id === id) ?? null;
  }

  async list(
    tenantId: string,
    opts?: AgentStoreListOpts,
  ): Promise<PaginatedResult<Agent>> {
    const limit = opts?.limit ?? 50;
    const cursor = opts?.cursor;
    let filtered = this.agents.filter((a) => a.tenantId === tenantId);
    if (cursor) {
      const idx = filtered.findIndex((a) => a.id === cursor);
      if (idx >= 0) filtered = filtered.slice(idx + 1);
    }
    const data = filtered.slice(0, limit);
    const hasMore = filtered.length > limit;
    return { data, hasMore };
  }

  async update(id: string, input: AgentStoreUpdateInput): Promise<Agent | null> {
    const agent = this.agents.find((a) => a.id === id);
    if (!agent) return null;
    if (input.name !== undefined) agent.name = input.name;
    if (input.model !== undefined) agent.model = input.model;
    if (input.system !== undefined) agent.system = input.system;
    if (input.runtime !== undefined) agent.runtime = input.runtime;
    agent.updatedAt = new Date();
    return agent;
  }

  async delete(id: string): Promise<boolean> {
    const idx = this.agents.findIndex((a) => a.id === id);
    if (idx < 0) return false;
    this.agents.splice(idx, 1);
    return true;
  }
}

// In-memory WorkspaceMetadataStore for testing
class InMemoryWorkspaceMetadataStore implements WorkspaceMetadataStore {
  private workspaces = new Map<string, Workspace>();
  private nextId = 1;
  public createCalls: WorkspaceMetadataStoreCreateInput[] = [];

  private key(tenantId: string, id: string): string {
    return `${tenantId} ${id}`;
  }

  async create(input: WorkspaceMetadataStoreCreateInput): Promise<Workspace> {
    this.createCalls.push(input);
    const id = input.id ?? `ws_${this.nextId++}`;
    const key = this.key(input.tenantId, id);
    const existing = this.workspaces.get(key);
    if (existing) return existing;
    const workspace: Workspace = { id, tenantId: input.tenantId, createdAt: new Date() };
    if (input.name != null) workspace.name = input.name;
    this.workspaces.set(key, workspace);
    return workspace;
  }

  async getById(tenantId: string, id: string): Promise<Workspace | null> {
    return this.workspaces.get(this.key(tenantId, id)) ?? null;
  }

  async softDelete(tenantId: string, id: string): Promise<Workspace | null> {
    const workspace = await this.getById(tenantId, id);
    if (workspace) workspace.deletedAt = new Date();
    return workspace;
  }

  async update(tenantId: string, id: string, input: { name?: string }): Promise<Workspace | null> {
    const workspace = await this.getById(tenantId, id);
    if (workspace && input.name !== undefined) workspace.name = input.name;
    return workspace;
  }

  async list(tenantId: string, includeDeleted = false): Promise<Workspace[]> {
    return [...this.workspaces.values()]
      .filter((w) => w.tenantId === tenantId && (includeDeleted || !w.deletedAt))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
}

function makeApiKeyStore(entries: Map<string, TenantContext>): ApiKeyStore {
  return {
    async findByKeyHash(keyHash) {
      return entries.get(keyHash) ?? null;
    },
  };
}

function createTestApp(options: { includeEventLog?: boolean } = {}) {
  process.env.AUTH_DISABLED = "true";
  const agentStore = new InMemoryAgentStore();
  const sessionStore = new InMemorySessionStore();
  const workspaceStore = new InMemoryWorkspaceMetadataStore();
  const eventLogStore = new InMemoryEventLogStore();
  const app = createApp({
    apiKeyStore: makeApiKeyStore(new Map()),
    agentStore,
    sessionStore,
    workspaceStore,
    ...(options.includeEventLog === false ? {} : { eventLogStore }),
  });
  return { app, agentStore, sessionStore, workspaceStore, eventLogStore };
}

describe("POST /v1/sessions", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("creates a session with valid agent id", async () => {
    const { app, agentStore } = createTestApp();
    const agent = await agentStore.create({
      tenantId: "dev",
      name: "My Agent",
      model: "claude-3",
      system: "You are helpful",
      runtime: "claude-code",
    });

    const res = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: agent.id }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toMatch(/^sess_/);
    expect(body.tenantId).toBe("dev");
    expect(body.agentId).toBe(agent.id);
    expect(body.status).toBe("idle");
    expect(body.agent).toBeDefined();
    expect(body.agent.id).toBe(agent.id);
    expect(body.agent.name).toBe("My Agent");
    expect(body.agent.model).toBe("claude-3");
    expect(body.agent.runtime).toBe("claude-code");
  });

  it("auto-creates and binds a Workspace when none is supplied", async () => {
    const { app, agentStore, workspaceStore } = createTestApp();
    const agent = await agentStore.create({
      tenantId: "dev",
      name: "My Agent",
      model: "claude-3",
      system: "sys",
      runtime: "claude-code",
    });

    const res = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: agent.id }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.workspaceId).toBeDefined();
    // Auto-created (no id supplied to the workspace store).
    expect(workspaceStore.createCalls).toHaveLength(1);
    expect(workspaceStore.createCalls[0].id).toBeUndefined();
    const ws = await workspaceStore.getById("dev", body.workspaceId);
    expect(ws).not.toBeNull();
    expect(ws!.tenantId).toBe("dev");
  });

  it("binds a supplied workspace_id as-is", async () => {
    const { app, agentStore, workspaceStore } = createTestApp();
    const agent = await agentStore.create({
      tenantId: "dev",
      name: "My Agent",
      model: "claude-3",
      system: "sys",
      runtime: "claude-code",
    });

    const res = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: agent.id, workspace_id: "my-workspace" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.workspaceId).toBe("my-workspace");
    expect(workspaceStore.createCalls[0].id).toBe("my-workspace");
  });

  it("lets many sessions bind the same Workspace concurrently", async () => {
    const { app, agentStore, workspaceStore } = createTestApp();
    const agent = await agentStore.create({
      tenantId: "dev",
      name: "My Agent",
      model: "claude-3",
      system: "sys",
      runtime: "claude-code",
    });

    const mk = () =>
      app.request("/v1/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: agent.id, workspace_id: "shared" }),
      });

    const [a, b] = await Promise.all([mk(), mk()]);
    const sa = await a.json();
    const sb = await b.json();
    expect(sa.workspaceId).toBe("shared");
    expect(sb.workspaceId).toBe("shared");
    expect(sa.id).not.toBe(sb.id);
    // Only one Workspace entity exists for the shared id.
    const ws = await workspaceStore.getById("dev", "shared");
    expect(ws).not.toBeNull();
  });

  it("passes workspace_name through when auto-creating a Workspace", async () => {
    const { app, agentStore, workspaceStore } = createTestApp();
    const agent = await agentStore.create({
      tenantId: "dev",
      name: "My Agent",
      model: "claude-3",
      system: "sys",
      runtime: "claude-code",
    });

    const res = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: agent.id, workspace_name: "Project X" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(workspaceStore.createCalls[0].name).toBe("Project X");
    const ws = await workspaceStore.getById("dev", body.workspaceId);
    expect(ws!.name).toBe("Project X");
  });

  it("rejects a non-string workspace_name", async () => {
    const { app, agentStore } = createTestApp();
    const agent = await agentStore.create({
      tenantId: "dev",
      name: "My Agent",
      model: "claude-3",
      system: "sys",
      runtime: "claude-code",
    });

    const res = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: agent.id, workspace_name: 123 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("workspace_name must be a string");
  });

  it("rejects a non-string workspace_id", async () => {
    const { app, agentStore } = createTestApp();
    const agent = await agentStore.create({
      tenantId: "dev",
      name: "My Agent",
      model: "claude-3",
      system: "sys",
      runtime: "claude-code",
    });

    const res = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: agent.id, workspace_id: 123 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("workspace_id must be a string");
  });

  it("stores a snapshot of the agent config at creation time", async () => {
    const { app, agentStore } = createTestApp();
    const agent = await agentStore.create({
      tenantId: "dev",
      name: "Original Name",
      model: "claude-3",
      system: "You are helpful",
      runtime: "claude-code",
    });

    // Create session
    const res = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: agent.id }),
    });
    expect(res.status).toBe(201);
    const session = await res.json();

    // Update the agent name
    await agentStore.update(agent.id, { name: "Updated Name" });

    // Session should still have the original agent snapshot
    const getRes = await app.request(`/v1/sessions/${session.id}`);
    const fetched = await getRes.json();
    expect(fetched.agent.name).toBe("Original Name");
  });

  it("returns 400 when agent field is missing", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing required field: agent");
  });

  it("returns 400 when agent field is not a string", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: 123 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing required field: agent");
  });

  it("returns 400 for invalid JSON body", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid JSON body");
  });

  it("returns 404 when agent does not exist", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "agent_nonexistent" }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Agent not found");
  });

  it("returns 404 when agent belongs to a different tenant", async () => {
    const { app, agentStore } = createTestApp();
    const agent = await agentStore.create({
      tenantId: "other-tenant",
      name: "Other Agent",
      model: "claude-3",
      system: "sys",
      runtime: "claude-code",
    });

    const res = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: agent.id }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Agent not found");
  });
});

describe("GET /v1/sessions", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("returns empty list when no sessions exist", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/sessions");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.has_more).toBe(false);
  });

  it("returns list of sessions", async () => {
    const { app, agentStore, sessionStore } = createTestApp();
    const agent = await agentStore.create({
      tenantId: "dev",
      name: "Agent",
      model: "claude-3",
      system: "sys",
      runtime: "claude-code",
    });
    await sessionStore.create({ tenantId: "dev", agentId: agent.id, agent, workspaceId: "ws_test" });
    await sessionStore.create({ tenantId: "dev", agentId: agent.id, agent, workspaceId: "ws_test" });

    const res = await app.request("/v1/sessions");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.has_more).toBe(false);
  });

  it("filters by agent_id", async () => {
    const { app, agentStore, sessionStore } = createTestApp();
    const agent1 = await agentStore.create({
      tenantId: "dev",
      name: "Agent 1",
      model: "claude-3",
      system: "sys",
      runtime: "claude-code",
    });
    const agent2 = await agentStore.create({
      tenantId: "dev",
      name: "Agent 2",
      model: "claude-3",
      system: "sys",
      runtime: "codex",
    });
    await sessionStore.create({ tenantId: "dev", agentId: agent1.id, agent: agent1, workspaceId: "ws_test" });
    await sessionStore.create({ tenantId: "dev", agentId: agent2.id, agent: agent2, workspaceId: "ws_test" });

    const res = await app.request(`/v1/sessions?agent_id=${agent1.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].agentId).toBe(agent1.id);
  });

  it("paginates each Workspace independently within an Agent before filtering the page", async () => {
    const { app, agentStore, sessionStore, workspaceStore } = createTestApp();
    const agent = await agentStore.create({ tenantId: "dev", name: "Agent", model: "claude-3", system: "sys", runtime: "claude-code" });
    await workspaceStore.create({ tenantId: "dev", id: "ws_project", name: "Project" });
    const input = { tenantId: "dev", agentId: agent.id, agent, workspaceId: "ws_project" };
    // A busy neighboring Workspace must not consume any of this project's five slots.
    for (let index = 0; index < 8; index++) {
      await sessionStore.create({ ...input, workspaceId: "ws_neighbor" });
    }
    await sessionStore.create({ ...input, agentId: "agent_other" });
    await sessionStore.create({ ...input, tenantId: "other-tenant" });
    await sessionStore.create({ ...input, loopId: "loop_review" });
    await sessionStore.create({ ...input, delegation: {
      parentSessionId: "sess_parent", parentTurnId: "turn_parent", parentToolUseId: "tool_child", sandboxSessionId: "sess_parent",
    } });
    const deleted = await sessionStore.create(input);
    await sessionStore.softDelete(deleted.id);
    const sessions = [];
    for (let index = 0; index < 7; index++) sessions.push(await sessionStore.create(input));

    const query = `agent_id=${agent.id}&workspace_id=ws_project&exclude_loop=true&exclude_delegated=true&limit=5`;
    const first = await app.request(`/v1/sessions?${query}`);
    expect(first.status).toBe(200);
    const page1 = await first.json();
    expect(page1.data.map((session: { id: string }) => session.id)).toEqual(sessions.slice(0, 5).map((session) => session.id));
    expect(page1).toMatchObject({ has_more: true, next_cursor: sessions[4].id });
    const second = await app.request(`/v1/sessions?${query}&cursor=${page1.next_cursor}`);
    const page2 = await second.json();
    expect(page2.data.map((session: { id: string }) => session.id)).toEqual(sessions.slice(5).map((session) => session.id));
    expect(page2.has_more).toBe(false);
    expect(page2.next_cursor).toBeUndefined();

    await workspaceStore.softDelete("dev", "ws_project");
    expect(await (await app.request(`/v1/sessions?${query}`)).json()).toEqual({ data: [], has_more: false });
    expect(await (await app.request("/v1/sessions?workspace_id=ws_missing")).json()).toEqual({ data: [], has_more: false });
  });

  it("lists recently modified Workspace Sessions first across stable cursor pages", async () => {
    const { app, agentStore, sessionStore, workspaceStore } = createTestApp();
    const agent = await agentStore.create({ tenantId: "dev", name: "Agent", model: "claude-3", system: "sys", runtime: "claude-code" });
    await workspaceStore.create({ tenantId: "dev", id: "ws_project", name: "Project" });
    const input = { tenantId: "dev", agentId: agent.id, agent, workspaceId: "ws_project" };
    const sessions = [];
    for (let index = 0; index < 7; index++) {
      const session = await sessionStore.create(input);
      session.createdAt = new Date(`2026-09-0${index + 1}T00:00:00.000Z`);
      session.updatedAt = new Date(index === 6 ? "2026-10-07T00:00:00.000Z" : "2026-10-08T00:00:00.000Z");
      sessions.push(session);
    }
    sessions[0].updatedAt = new Date("2026-10-10T00:00:00.000Z");
    sessions[1].updatedAt = new Date("2026-10-09T00:00:00.000Z");
    const neighbor = await sessionStore.create({ ...input, workspaceId: "ws_neighbor" });
    neighbor.updatedAt = new Date("2026-10-11T00:00:00.000Z");
    const query = `agent_id=${agent.id}&workspace_id=ws_project&exclude_loop=true&exclude_delegated=true&limit=5`;

    const first = await app.request(`/v1/sessions?${query}&order=updated_at`);
    expect(first.status).toBe(200);
    const page1 = await first.json();
    const expected = [sessions[0], sessions[1], sessions[5], sessions[4], sessions[3], sessions[2], sessions[6]];
    expect(page1.data.map((session: { id: string }) => session.id)).toEqual(expected.slice(0, 5).map((session) => session.id));
    expect(page1.has_more).toBe(true);
    expect(page1.next_cursor).toMatch(/^updated_at:/);

    await sessionStore.setTitle(sessions[3].id, "Modified since the previous page");
    await sessionStore.softDelete(sessions[3].id);
    const second = await app.request(`/v1/sessions?${query}&order=updated_at&cursor=${encodeURIComponent(page1.next_cursor)}`);
    expect(second.status).toBe(200);
    const page2 = await second.json();
    expect(page2.data.map((session: { id: string }) => session.id)).toEqual(expected.slice(5).map((session) => session.id));
    expect(page2.has_more).toBe(false);
    expect(page2.next_cursor).toBeUndefined();

    // Omitting the order keeps the established list contract.
    const defaultPage = await (await app.request(`/v1/sessions?${query}`)).json();
    expect(defaultPage.data.map((session: { id: string }) => session.id)).toEqual(sessions.filter((session) => !session.deletedAt).slice(0, 5).map((session) => session.id));
  });

  it.each([
    "order=created_at",
    "order=",
    "order=updated_at&cursor=sess_1",
    "order=updated_at&cursor=updated_at:invalid",
    `order=updated_at&cursor=updated_at:${Buffer.from(JSON.stringify(["yesterday", "sess_1"])).toString("base64url")}`,
    `order=updated_at&cursor=updated_at:${Buffer.from(JSON.stringify(["2026-02-30T00:00:00.000Z", "sess_1"])).toString("base64url")}`,
  ])("rejects invalid Session order or cursor: %s", async (query) => {
    const { app } = createTestApp();
    expect((await app.request(`/v1/sessions?${query}`)).status).toBe(400);
  });

  it("paginates loose Sessions without named or deleted Workspaces crowding them out", async () => {
    const { app, agentStore, sessionStore, workspaceStore } = createTestApp();
    const agent = await agentStore.create({ tenantId: "dev", name: "Agent", model: "claude-3", system: "sys", runtime: "claude-code" });
    const input = { tenantId: "dev", agentId: agent.id, agent, workspaceId: "ws_named" };
    await workspaceStore.create({ tenantId: "dev", id: "ws_named", name: "Project" });
    for (let index = 0; index < 8; index++) await sessionStore.create(input);
    await workspaceStore.create({ tenantId: "dev", id: "ws_deleted" });
    await workspaceStore.softDelete("dev", "ws_deleted");
    await sessionStore.create({ ...input, workspaceId: "ws_deleted" });
    await sessionStore.create({ ...input, workspaceId: "ws_loose", agentId: "agent_other" });
    // Metadata belonging to another Tenant cannot hide this Tenant's unnamed Workspace.
    await workspaceStore.create({ tenantId: "other-tenant", id: "ws_loose", name: "Foreign project" });
    await workspaceStore.create({ tenantId: "dev", id: "ws_loose" });
    await workspaceStore.create({ tenantId: "dev", id: "ws_empty_name", name: "" });
    const sessions = [];
    for (let index = 0; index < 6; index++) {
      sessions.push(await sessionStore.create({ ...input, workspaceId: "ws_loose" }));
    }
    sessions.push(await sessionStore.create({ ...input, workspaceId: "ws_empty_name" }));

    const query = `agent_id=${agent.id}&exclude_named_workspaces=true&exclude_loop=true&exclude_delegated=true&limit=5`;
    const page1 = await (await app.request(`/v1/sessions?${query}`)).json();
    expect(page1.data.map((session: { id: string }) => session.id)).toEqual(sessions.slice(0, 5).map((session) => session.id));
    expect(page1).toMatchObject({ has_more: true, next_cursor: sessions[4].id });
    const page2 = await (await app.request(`/v1/sessions?${query}&cursor=${page1.next_cursor}`)).json();
    expect(page2.data.map((session: { id: string }) => session.id)).toEqual(sessions.slice(5).map((session) => session.id));
    expect(page2.has_more).toBe(false);
    expect(page2.next_cursor).toBeUndefined();
    for (const filter of ["", "&exclude_named_workspaces=false"]) {
      const result = await (await app.request(`/v1/sessions?agent_id=${agent.id}${filter}`)).json();
      expect(result.data).toHaveLength(15);
    }
    const scoped = await (await app.request(`/v1/sessions?agent_id=${agent.id}&workspace_id=ws_named&exclude_named_workspaces=false`)).json();
    expect(scoped.data).toHaveLength(8);
  });

  it.each([
    "exclude_named_workspaces=invalid",
    "exclude_named_workspaces=1",
    "workspace_id=ws_project&exclude_named_workspaces=true",
  ])("rejects invalid Workspace filters: %s", async (query) => {
    const { app } = createTestApp();
    expect((await app.request(`/v1/sessions?${query}`)).status).toBe(400);
  });

  it("excludes delegated children before pagination only when requested", async () => {
    const { app, agentStore, sessionStore } = createTestApp();
    const agent = await agentStore.create({ tenantId: "dev", name: "Agent", model: "claude-3", system: "sys", runtime: "claude-code" });
    const input = { tenantId: "dev", agentId: agent.id, agent, workspaceId: "ws_test" };
    const child = await sessionStore.create({ ...input, delegation: {
      parentSessionId: "sess_parent", parentTurnId: "turn_parent", parentToolUseId: "tool_child", sandboxSessionId: "sess_parent",
    } });
    const roots = [await sessionStore.create(input), await sessionStore.create(input)];
    for (const query of ["", "?exclude_delegated=false"]) {
      const response = await app.request(`/v1/sessions${query}`);
      expect((await response.json()).data).toHaveLength(3);
    }
    const first = await app.request(`/v1/sessions?agent_id=${agent.id}&exclude_loop=true&exclude_delegated=true&limit=1`);
    expect(first.status).toBe(200);
    const page1 = await first.json();
    expect(page1).toMatchObject({ data: [{ id: roots[0].id }], has_more: true, next_cursor: roots[0].id });
    const second = await app.request(`/v1/sessions?exclude_delegated=true&limit=1&cursor=${page1.next_cursor}`);
    expect(await second.json()).toMatchObject({ data: [{ id: roots[1].id }], has_more: false });
    // The opt-in list filter does not remove access to the child detail.
    expect((await app.request(`/v1/sessions/${child.id}`)).status).toBe(200);
    expect((await app.request("/v1/sessions?exclude_delegated=invalid")).status).toBe(400);
  });

  it("excludes Loop-owned Sessions before pagination when requested", async () => {
    const { app, agentStore, sessionStore } = createTestApp();
    const agent = await agentStore.create({
      tenantId: "dev",
      name: "Agent",
      model: "claude-3",
      system: "sys",
      runtime: "claude-code",
    });
    for (let index = 0; index < 3; index++) {
      await sessionStore.create({
        tenantId: "dev",
        agentId: agent.id,
        agent,
        workspaceId: `ws_loop_${index}`,
        loopId: "loop_review",
      });
    }
    const loose = await sessionStore.create({
      tenantId: "dev",
      agentId: agent.id,
      agent,
      workspaceId: "ws_loose",
    });

    const res = await app.request(
      `/v1/sessions?agent_id=${agent.id}&exclude_loop=true&limit=1`,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([expect.objectContaining({ id: loose.id })]);
  });

  it("filters by status", async () => {
    const { app, agentStore, sessionStore } = createTestApp();
    const agent = await agentStore.create({
      tenantId: "dev",
      name: "Agent",
      model: "claude-3",
      system: "sys",
      runtime: "claude-code",
    });
    await sessionStore.create({ tenantId: "dev", agentId: agent.id, agent, workspaceId: "ws_test" });
    const sess2 = await sessionStore.create({ tenantId: "dev", agentId: agent.id, agent, workspaceId: "ws_test" });
    await sessionStore.updateStatus(sess2.id, "running");

    const res = await app.request("/v1/sessions?status=running");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].status).toBe("running");
  });

  it("respects limit parameter", async () => {
    const { app, agentStore, sessionStore } = createTestApp();
    const agent = await agentStore.create({
      tenantId: "dev",
      name: "Agent",
      model: "claude-3",
      system: "sys",
      runtime: "claude-code",
    });
    for (let i = 0; i < 5; i++) {
      await sessionStore.create({ tenantId: "dev", agentId: agent.id, agent, workspaceId: "ws_test" });
    }

    const res = await app.request("/v1/sessions?limit=3");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(3);
    expect(body.has_more).toBe(true);
    expect(body.next_cursor).toBeDefined();
  });

  it("supports cursor pagination", async () => {
    const { app, agentStore, sessionStore } = createTestApp();
    const agent = await agentStore.create({
      tenantId: "dev",
      name: "Agent",
      model: "claude-3",
      system: "sys",
      runtime: "claude-code",
    });
    for (let i = 0; i < 5; i++) {
      await sessionStore.create({ tenantId: "dev", agentId: agent.id, agent, workspaceId: "ws_test" });
    }

    const page1 = await app.request("/v1/sessions?limit=3");
    const body1 = await page1.json();
    expect(body1.data).toHaveLength(3);
    expect(body1.has_more).toBe(true);

    const page2 = await app.request(`/v1/sessions?limit=3&cursor=${body1.next_cursor}`);
    const body2 = await page2.json();
    expect(body2.data).toHaveLength(2);
    expect(body2.has_more).toBe(false);
  });

  it("isolates sessions by tenant", async () => {
    const { app, agentStore, sessionStore } = createTestApp();
    const agent = await agentStore.create({
      tenantId: "dev",
      name: "Agent",
      model: "claude-3",
      system: "sys",
      runtime: "claude-code",
    });
    await sessionStore.create({ tenantId: "dev", agentId: agent.id, agent, workspaceId: "ws_test" });
    await sessionStore.create({ tenantId: "other-tenant", agentId: agent.id, agent, workspaceId: "ws_test" });

    const res = await app.request("/v1/sessions");
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].tenantId).toBe("dev");
  });
});

describe("GET /v1/sessions/:id/usage", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("returns exact snake_case usage aggregated from durable model spans", async () => {
    const { app, agentStore, sessionStore, eventLogStore } = createTestApp();
    const agent = await agentStore.create({
      tenantId: "dev",
      name: "Agent",
      model: "model",
      system: "system",
      runtime: "mock",
    });
    const session = await sessionStore.create({
      tenantId: "dev",
      agentId: agent.id,
      agent,
      workspaceId: "ws_1",
    });
    await eventLogStore.append(session.id, {
      type: "span.model_request_end",
      data: {
        usage: {
          inputTokens: 0,
          outputTokens: 7,
          cacheReadTokens: 0,
          cacheWriteTokens: 2,
        },
      },
      sessionThreadId: "thread_1",
    });

    const res = await app.request(`/v1/sessions/${session.id}/usage`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      usage: {
        input_tokens: 0,
        output_tokens: 7,
        cache_read_tokens: 0,
        cache_write_tokens: 2,
        total_tokens: 7,
        cache_hit_rate: null,
      },
    });
  });

  it("returns 503 when the usage store is unavailable", async () => {
    const { app, agentStore, sessionStore } = createTestApp({ includeEventLog: false });
    const agent = await agentStore.create({
      tenantId: "dev",
      name: "Agent",
      model: "model",
      system: "system",
      runtime: "mock",
    });
    const session = await sessionStore.create({
      tenantId: "dev",
      agentId: agent.id,
      agent,
      workspaceId: "ws_1",
    });

    const res = await app.request(`/v1/sessions/${session.id}/usage`);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Usage service unavailable" });
  });

  it("does not expose usage for another tenant's Session", async () => {
    const { app, agentStore, sessionStore } = createTestApp();
    const agent = await agentStore.create({
      tenantId: "other",
      name: "Agent",
      model: "model",
      system: "system",
      runtime: "mock",
    });
    const session = await sessionStore.create({
      tenantId: "other",
      agentId: agent.id,
      agent,
      workspaceId: "ws_1",
    });

    const res = await app.request(`/v1/sessions/${session.id}/usage`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Session not found" });
  });
});

describe("GET /v1/sessions/:id", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("returns a session by id", async () => {
    const { app, agentStore, sessionStore } = createTestApp();
    const agent = await agentStore.create({
      tenantId: "dev",
      name: "My Agent",
      model: "claude-3",
      system: "You are helpful",
      runtime: "claude-code",
    });
    const session = await sessionStore.create({
      tenantId: "dev",
      agentId: agent.id,
      agent,
      workspaceId: "ws_test",
    });

    const res = await app.request(`/v1/sessions/${session.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(session.id);
    expect(body.agentId).toBe(agent.id);
    expect(body.status).toBe("idle");
    expect(body.agent.name).toBe("My Agent");
  });

  it("returns 404 for non-existent session", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/sessions/sess_nonexistent");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Session not found");
  });

  it("returns 404 for session belonging to different tenant", async () => {
    const { app, agentStore, sessionStore } = createTestApp();
    const agent = await agentStore.create({
      tenantId: "other-tenant",
      name: "Other Agent",
      model: "claude-3",
      system: "sys",
      runtime: "claude-code",
    });
    const session = await sessionStore.create({
      tenantId: "other-tenant",
      agentId: agent.id,
      agent,
      workspaceId: "ws_test",
    });

    const res = await app.request(`/v1/sessions/${session.id}`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Session not found");
  });
});

describe("public Session projection", () => {
  it("never exposes a legacy managed MCP connection from Session snapshots", async () => {
    const { app, agentStore } = createTestApp();
    const agent = await agentStore.create({
      tenantId: "dev",
      name: "Legacy MCP Agent",
      model: "claude-3",
      system: "sys",
      runtime: "claude-code",
    });
    agent.mcpServers = [{
      name: "rds-mcp",
      url: "https://campaign.welltop.tech/agent/mcp/rds",
      transport: "streamable-http",
      headers: { Authorization: "Bearer ${RDS_MCP_APIKEY}" },
    }];

    const createdResponse = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: agent.id }),
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();

    const listedResponse = await app.request("/v1/sessions");
    const listed = await listedResponse.json();
    const fetchedResponse = await app.request(`/v1/sessions/${created.id}`);
    const fetched = await fetchedResponse.json();

    for (const session of [created, listed.data[0], fetched]) {
      expect(session.agent.mcpServers).toEqual([{
        catalogId: "rds-mcp",
        name: "rds-mcp",
      }]);
      const serialized = JSON.stringify(session);
      expect(serialized).not.toContain("campaign.welltop.tech");
      expect(serialized).not.toContain("Authorization");
      expect(serialized).not.toContain("RDS_MCP_APIKEY");
    }
  });
});

describe("DELETE /v1/sessions/:id", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("terminates a session", async () => {
    const { app, agentStore, sessionStore } = createTestApp();
    const agent = await agentStore.create({
      tenantId: "dev",
      name: "My Agent",
      model: "claude-3",
      system: "You are helpful",
      runtime: "claude-code",
    });
    const session = await sessionStore.create({
      tenantId: "dev",
      agentId: agent.id,
      agent,
      workspaceId: "ws_test",
    });

    const res = await app.request(`/v1/sessions/${session.id}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("session_terminated");
    expect(body.id).toBe(session.id);

    // Verify session is now terminated
    const getRes = await app.request(`/v1/sessions/${session.id}`);
    const fetched = await getRes.json();
    expect(fetched.status).toBe("terminated");
    expect(fetched.terminatedAt).toBeDefined();
  });

  it("returns 404 for non-existent session", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/sessions/sess_nonexistent", {
      method: "DELETE",
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Session not found");
  });

  it("returns 404 for session belonging to different tenant", async () => {
    const { app, agentStore, sessionStore } = createTestApp();
    const agent = await agentStore.create({
      tenantId: "other-tenant",
      name: "Other Agent",
      model: "claude-3",
      system: "sys",
      runtime: "claude-code",
    });
    const session = await sessionStore.create({
      tenantId: "other-tenant",
      agentId: agent.id,
      agent,
      workspaceId: "ws_test",
    });

    const res = await app.request(`/v1/sessions/${session.id}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Session not found");
  });

  it("can terminate an already running session", async () => {
    const { app, agentStore, sessionStore } = createTestApp();
    const agent = await agentStore.create({
      tenantId: "dev",
      name: "My Agent",
      model: "claude-3",
      system: "You are helpful",
      runtime: "claude-code",
    });
    const session = await sessionStore.create({
      tenantId: "dev",
      agentId: agent.id,
      agent,
      workspaceId: "ws_test",
    });
    await sessionStore.updateStatus(session.id, "running");

    const res = await app.request(`/v1/sessions/${session.id}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("session_terminated");

    const getRes = await app.request(`/v1/sessions/${session.id}`);
    const fetched = await getRes.json();
    expect(fetched.status).toBe("terminated");
  });
});
