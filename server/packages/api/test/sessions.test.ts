import { describe, it, expect, beforeEach } from "vitest";
import { createApp } from "../src/app.js";
import { InMemoryEventLogStore } from "@oma-server/store-memory";
import type { ApiKeyStore, TenantContext } from "../src/types.js";
import type {
  AgentStore,
  Agent,
  AgentStoreCreateInput,
  AgentStoreUpdateInput,
  AgentStoreListOpts,
  SessionStore,
  Session,
  SessionStoreCreateInput,
  SessionStoreListOpts,
  SessionStatus,
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

// In-memory SessionStore for testing
class InMemorySessionStore implements SessionStore {
  private sessions: Session[] = [];
  private nextId = 1;

  async create(input: SessionStoreCreateInput): Promise<Session> {
    const session: Session = {
      id: `sess_${this.nextId++}`,
      tenantId: input.tenantId,
      agentId: input.agentId,
      status: "idle",
      agent: structuredClone(input.agent),
      workspaceId: input.workspaceId,
      loopId: input.loopId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.sessions.push(session);
    return session;
  }

  async getById(id: string): Promise<Session | null> {
    return this.sessions.find((s) => s.id === id) ?? null;
  }

  async list(
    tenantId: string,
    opts?: SessionStoreListOpts,
  ): Promise<PaginatedResult<Session>> {
    const limit = opts?.limit ?? 50;
    const cursor = opts?.cursor;
    const agentId = opts?.agentId;
    const status = opts?.status;
    const loopId = opts?.loopId;
    const withoutLoop = opts?.withoutLoop;

    let filtered = this.sessions.filter((s) => s.tenantId === tenantId);
    if (agentId) filtered = filtered.filter((s) => s.agentId === agentId);
    if (status) filtered = filtered.filter((s) => s.status === status);
    if (loopId) filtered = filtered.filter((s) => s.loopId === loopId);
    if (withoutLoop) filtered = filtered.filter((s) => !s.loopId);

    if (cursor) {
      const idx = filtered.findIndex((s) => s.id === cursor);
      if (idx >= 0) filtered = filtered.slice(idx + 1);
    }

    const data = filtered.slice(0, limit);
    const hasMore = filtered.length > limit;
    return { data, hasMore };
  }

  async updateStatus(id: string, status: SessionStatus): Promise<Session | null> {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return null;
    session.status = status;
    session.updatedAt = new Date();
    return session;
  }

  async setTitle(id: string, title: string): Promise<Session | null> {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return null;
    session.title = title;
    session.updatedAt = new Date();
    return session;
  }

  async terminate(id: string): Promise<Session | null> {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return null;
    session.status = "terminated";
    session.terminatedAt = new Date();
    session.updatedAt = new Date();
    return session;
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

  async list(tenantId: string): Promise<Workspace[]> {
    return [...this.workspaces.values()]
      .filter((w) => w.tenantId === tenantId)
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
