import { describe, it, expect, beforeEach } from "vitest";
import { createApp } from "../src/app.js";
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
  EventLogStore,
  EventLogStoreAppendInput,
  EventLogStoreGetEventsOpts,
  PendingEventStore,
  PendingEvent,
  PendingEventEnqueueInput,
  StoredEvent,
  PaginatedResult,
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

    let filtered = this.sessions.filter((s) => s.tenantId === tenantId);
    if (agentId) filtered = filtered.filter((s) => s.agentId === agentId);
    if (status) filtered = filtered.filter((s) => s.status === status);

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

  async terminate(id: string): Promise<Session | null> {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return null;
    session.status = "terminated";
    session.terminatedAt = new Date();
    session.updatedAt = new Date();
    return session;
  }
}

// In-memory EventLogStore for testing
class InMemoryEventLogStore implements EventLogStore {
  private events: Map<string, StoredEvent[]> = new Map();
  private seqCounters: Map<string, number> = new Map();

  async append(sessionId: string, event: EventLogStoreAppendInput): Promise<StoredEvent> {
    const currentSeq = this.seqCounters.get(sessionId) ?? 0;
    const nextSeq = currentSeq + 1;
    this.seqCounters.set(sessionId, nextSeq);

    const stored: StoredEvent = {
      sessionId,
      seq: nextSeq,
      type: event.type,
      data: event.data,
      ts: new Date(),
      sessionThreadId: event.sessionThreadId,
    };

    const sessionEvents = this.events.get(sessionId) ?? [];
    sessionEvents.push(stored);
    this.events.set(sessionId, sessionEvents);

    return stored;
  }

  async getEvents(
    sessionId: string,
    opts?: EventLogStoreGetEventsOpts,
  ): Promise<PaginatedResult<StoredEvent>> {
    const allEvents = this.events.get(sessionId) ?? [];
    const afterSeq = opts?.afterSeq ?? 0;
    const limit = opts?.limit ?? 50;

    const filtered = allEvents.filter((e) => e.seq > afterSeq);
    const data = filtered.slice(0, limit);
    const hasMore = filtered.length > limit;

    return { data, hasMore };
  }

}

// In-memory PendingEventStore for testing
class InMemoryPendingEventStore implements PendingEventStore {
  private queues: Map<string, PendingEvent[]> = new Map();
  private nextId = 1;

  async enqueue(sessionId: string, event: PendingEventEnqueueInput): Promise<PendingEvent> {
    const pending: PendingEvent = {
      id: `pending_${this.nextId++}`,
      sessionId,
      type: event.type,
      data: event.data,
      sessionThreadId: event.sessionThreadId,
      arrivedAt: new Date(),
    };
    const queue = this.queues.get(sessionId) ?? [];
    queue.push(pending);
    this.queues.set(sessionId, queue);
    return pending;
  }

  async dequeue(sessionId: string): Promise<PendingEvent | null> {
    const queue = this.queues.get(sessionId) ?? [];
    if (queue.length === 0) return null;
    return queue.shift()!;
  }

  async peek(sessionId: string): Promise<PendingEvent | null> {
    const queue = this.queues.get(sessionId) ?? [];
    return queue[0] ?? null;
  }

  async count(sessionId: string): Promise<number> {
    const queue = this.queues.get(sessionId) ?? [];
    return queue.length;
  }
}

function makeApiKeyStore(entries: Map<string, TenantContext>): ApiKeyStore {
  return {
    async findByKeyHash(keyHash) {
      return entries.get(keyHash) ?? null;
    },
  };
}

function createTestApp() {
  process.env.AUTH_DISABLED = "true";
  const agentStore = new InMemoryAgentStore();
  const sessionStore = new InMemorySessionStore();
  const eventLogStore = new InMemoryEventLogStore();
  const pendingEventStore = new InMemoryPendingEventStore();
  const app = createApp({
    apiKeyStore: makeApiKeyStore(new Map()),
    agentStore,
    sessionStore,
    eventLogStore,
    pendingEventStore,
  });
  return { app, agentStore, sessionStore, eventLogStore, pendingEventStore };
}

async function createTestSession(
  agentStore: InMemoryAgentStore,
  sessionStore: InMemorySessionStore,
  tenantId = "dev",
) {
  const agent = await agentStore.create({
    tenantId,
    name: "Test Agent",
    model: "claude-3",
    system: "You are helpful",
    runtime: "claude-code",
  });
  const session = await sessionStore.create({
    tenantId,
    agentId: agent.id,
    agent,
  });
  return { agent, session };
}

describe("POST /v1/sessions/:id/events", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("appends user.message and returns 202", async () => {
    const { app, agentStore, sessionStore, pendingEventStore } = createTestApp();
    const { session } = await createTestSession(agentStore, sessionStore);

    const res = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [{ type: "user.message", data: { text: "Hello" } }],
      }),
    });

    expect(res.status).toBe(202);

    // Verify message is in pending store
    const pending = await pendingEventStore.peek(session.id);
    expect(pending).not.toBeNull();
    expect(pending!.type).toBe("user.message");
  });

  it("rejects agent.message with 400", async () => {
    const { app, agentStore, sessionStore } = createTestApp();
    const { session } = await createTestSession(agentStore, sessionStore);

    const res = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [{ type: "agent.message", data: { text: "Hi" } }],
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Unsupported event type: agent.message");
  });

  it("user.interrupt is not persisted and returns accepted/interrupted", async () => {
    const { app, agentStore, sessionStore, eventLogStore } = createTestApp();
    const { session } = await createTestSession(agentStore, sessionStore);

    const res = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [{ type: "user.interrupt", data: {} }],
      }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.accepted).toBe(true);
    expect(body.interrupted).toBe(true);

    // Verify nothing was persisted
    const events = await eventLogStore.getEvents(session.id);
    expect(events.data).toHaveLength(0);
  });

  it("user.message goes to pending store, not canonical log", async () => {
    const { app, agentStore, sessionStore, eventLogStore, pendingEventStore } = createTestApp();
    const { session } = await createTestSession(agentStore, sessionStore);

    await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [{ type: "user.message", data: { text: "Hello" } }],
      }),
    });

    // Not in canonical log
    const events = await eventLogStore.getEvents(session.id);
    expect(events.data).toHaveLength(0);

    // In pending store
    expect(await pendingEventStore.count(session.id)).toBe(1);
  });

  it("user.define_outcome goes directly to canonical log", async () => {
    const { app, agentStore, sessionStore, eventLogStore } = createTestApp();
    const { session } = await createTestSession(agentStore, sessionStore);

    await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [{ type: "user.define_outcome", data: { outcome: "success" } }],
      }),
    });

    const events = await eventLogStore.getEvents(session.id);
    expect(events.data).toHaveLength(1);
    expect(events.data[0].type).toBe("user.define_outcome");
    expect(events.data[0].seq).toBe(1);
  });

  it("returns 404 for non-existent session", async () => {
    const { app } = createTestApp();

    const res = await app.request("/v1/sessions/sess_nonexistent/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [{ type: "user.message", data: { text: "Hello" } }],
      }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Session not found");
  });

  it("returns 404 for session belonging to different tenant", async () => {
    const { app, agentStore, sessionStore } = createTestApp();
    const { session } = await createTestSession(agentStore, sessionStore, "other-tenant");

    const res = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [{ type: "user.message", data: { text: "Hello" } }],
      }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Session not found");
  });

  it("enqueues multiple user.messages into pending store", async () => {
    const { app, agentStore, sessionStore, pendingEventStore } = createTestApp();
    const { session } = await createTestSession(agentStore, sessionStore);

    const res = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [
          { type: "user.message", data: { text: "First" } },
          { type: "user.message", data: { text: "Second" } },
        ],
      }),
    });

    expect(res.status).toBe(202);
    expect(await pendingEventStore.count(session.id)).toBe(2);
  });

  it("enqueues user.tool_confirmation into pending store", async () => {
    const { app, agentStore, sessionStore, pendingEventStore } = createTestApp();
    const { session } = await createTestSession(agentStore, sessionStore);

    const res = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [{ type: "user.tool_confirmation", data: { confirmed: true } }],
      }),
    });

    expect(res.status).toBe(202);
    const pending = await pendingEventStore.dequeue(session.id);
    expect(pending).not.toBeNull();
    expect(pending!.type).toBe("user.tool_confirmation");
  });

  it("enqueues user.custom_tool_result into pending store", async () => {
    const { app, agentStore, sessionStore, pendingEventStore } = createTestApp();
    const { session } = await createTestSession(agentStore, sessionStore);

    const res = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [{ type: "user.custom_tool_result", data: { result: "done" } }],
      }),
    });

    expect(res.status).toBe(202);
    const pending = await pendingEventStore.dequeue(session.id);
    expect(pending).not.toBeNull();
    expect(pending!.type).toBe("user.custom_tool_result");
  });
});

describe("GET /v1/sessions/:id/events", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("returns events for a session", async () => {
    const { app, agentStore, sessionStore, eventLogStore } = createTestApp();
    const { session } = await createTestSession(agentStore, sessionStore);

    await eventLogStore.append(session.id, {
      type: "user.message",
      data: { text: "Hello" },
      sessionThreadId: "sthr_primary",
    });

    const res = await app.request(`/v1/sessions/${session.id}/events`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].type).toBe("user.message");
    expect(body.has_more).toBe(false);
  });

  it("supports after_seq pagination", async () => {
    const { app, agentStore, sessionStore, eventLogStore } = createTestApp();
    const { session } = await createTestSession(agentStore, sessionStore);

    // Append 5 events
    for (let i = 0; i < 5; i++) {
      await eventLogStore.append(session.id, {
        type: "user.message",
        data: { text: `Message ${i + 1}` },
        sessionThreadId: "sthr_primary",
      });
    }

    const res = await app.request(`/v1/sessions/${session.id}/events?after_seq=2&limit=2`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0].seq).toBe(3);
    expect(body.data[1].seq).toBe(4);
    expect(body.has_more).toBe(true);
  });

  it("returns 404 for non-existent session", async () => {
    const { app } = createTestApp();

    const res = await app.request("/v1/sessions/sess_nonexistent/events");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Session not found");
  });

  it("returns 404 for session belonging to different tenant", async () => {
    const { app, agentStore, sessionStore } = createTestApp();
    const { session } = await createTestSession(agentStore, sessionStore, "other-tenant");

    const res = await app.request(`/v1/sessions/${session.id}/events`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Session not found");
  });

  it("defaults to limit 50", async () => {
    const { app, agentStore, sessionStore, eventLogStore } = createTestApp();
    const { session } = await createTestSession(agentStore, sessionStore);

    // Append 60 events
    for (let i = 0; i < 60; i++) {
      await eventLogStore.append(session.id, {
        type: "user.message",
        data: { text: `Message ${i + 1}` },
        sessionThreadId: "sthr_primary",
      });
    }

    const res = await app.request(`/v1/sessions/${session.id}/events`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(50);
    expect(body.has_more).toBe(true);
  });
});
