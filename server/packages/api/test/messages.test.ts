import { describe, it, expect, beforeEach } from "vitest";
import { createApp } from "../src/app.js";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import type { SessionRouter } from "@oma-server/session-router";
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
  async list(tenantId: string, _opts?: AgentStoreListOpts): Promise<PaginatedResult<Agent>> {
    return { data: this.agents.filter((a) => a.tenantId === tenantId), hasMore: false };
  }
  async update(id: string, input: AgentStoreUpdateInput): Promise<Agent | null> {
    const a = this.agents.find((x) => x.id === id);
    if (!a) return null;
    if (input.name !== undefined) a.name = input.name;
    return a;
  }
  async delete(id: string): Promise<boolean> {
    const i = this.agents.findIndex((a) => a.id === id);
    if (i < 0) return false;
    this.agents.splice(i, 1);
    return true;
  }
}

class InMemorySessionStore implements SessionStore {
  private sessions: Session[] = [];
  private nextId = 1;
  public setTitleCalls: Array<{ id: string; title: string }> = [];
  async create(input: SessionStoreCreateInput): Promise<Session> {
    const session: Session = {
      id: `sess_${this.nextId++}`,
      tenantId: input.tenantId,
      agentId: input.agentId,
      status: "idle",
      agent: structuredClone(input.agent),
      workspaceId: input.workspaceId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.sessions.push(session);
    return session;
  }
  async getById(id: string): Promise<Session | null> {
    return this.sessions.find((s) => s.id === id) ?? null;
  }
  async list(tenantId: string, _opts?: SessionStoreListOpts): Promise<PaginatedResult<Session>> {
    return { data: this.sessions.filter((s) => s.tenantId === tenantId), hasMore: false };
  }
  async updateStatus(id: string, status: SessionStatus): Promise<Session | null> {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return null;
    s.status = status;
    return s;
  }
  async setTitle(id: string, title: string): Promise<Session | null> {
    this.setTitleCalls.push({ id, title });
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return null;
    s.title = title;
    s.updatedAt = new Date();
    return s;
  }
  async terminate(id: string): Promise<Session | null> {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return null;
    s.status = "terminated";
    s.terminatedAt = new Date();
    return s;
  }
}

class InMemoryEventLogStore implements EventLogStore {
  private events = new Map<string, StoredEvent[]>();
  private seq = new Map<string, number>();
  async append(sessionId: string, event: EventLogStoreAppendInput): Promise<StoredEvent> {
    const next = (this.seq.get(sessionId) ?? 0) + 1;
    this.seq.set(sessionId, next);
    const stored: StoredEvent = {
      sessionId,
      seq: next,
      type: event.type,
      data: event.data,
      ts: new Date(),
      sessionThreadId: event.sessionThreadId,
    };
    const list = this.events.get(sessionId) ?? [];
    list.push(stored);
    this.events.set(sessionId, list);
    return stored;
  }
  async getEvents(sessionId: string, opts?: EventLogStoreGetEventsOpts): Promise<PaginatedResult<StoredEvent>> {
    const all = this.events.get(sessionId) ?? [];
    const after = opts?.afterSeq ?? 0;
    return { data: all.filter((e) => e.seq > after), hasMore: false };
  }
}

class InMemoryPendingEventStore implements PendingEventStore {
  private queues = new Map<string, PendingEvent[]>();
  private nextId = 1;
  async enqueue(sessionId: string, event: PendingEventEnqueueInput): Promise<PendingEvent> {
    const p: PendingEvent = {
      id: `pending_${this.nextId++}`,
      sessionId,
      type: event.type,
      data: event.data,
      sessionThreadId: event.sessionThreadId,
      arrivedAt: new Date(),
    };
    const q = this.queues.get(sessionId) ?? [];
    q.push(p);
    this.queues.set(sessionId, q);
    return p;
  }
  async dequeue(sessionId: string): Promise<PendingEvent | null> {
    const q = this.queues.get(sessionId) ?? [];
    return q.shift() ?? null;
  }
  async peek(sessionId: string): Promise<PendingEvent | null> {
    return (this.queues.get(sessionId) ?? [])[0] ?? null;
  }
  async count(sessionId: string): Promise<number> {
    return (this.queues.get(sessionId) ?? []).length;
  }
}

function makeApiKeyStore(entries: Map<string, TenantContext>): ApiKeyStore {
  return { async findByKeyHash(keyHash) { return entries.get(keyHash) ?? null; } };
}

function createTestApp() {
  process.env.AUTH_DISABLED = "true";
  const agentStore = new InMemoryAgentStore();
  const sessionStore = new InMemorySessionStore();
  const eventLogStore = new InMemoryEventLogStore();
  const pendingEventStore = new InMemoryPendingEventStore();
  const eventStreamHub = new InProcessEventStreamHub();
  // Fake router: closes the SSE stream by publishing session.status_idle so the
  // /messages handler returns instead of hanging.
  const sessionRouter = {
    handleNewEvent(sessionId: string) {
      setTimeout(() => {
        eventStreamHub.publish(sessionId, { type: "session.status_idle", data: {} });
      }, 5);
    },
  } as unknown as SessionRouter;
  const app = createApp({
    apiKeyStore: makeApiKeyStore(new Map()),
    agentStore,
    sessionStore,
    eventLogStore,
    pendingEventStore,
    eventStreamHub,
    sessionRouter,
  });
  return { app, agentStore, sessionStore };
}

async function drain(res: Response) {
  const reader = res.body!.getReader();
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    const { done } = await reader.read();
    if (done) break;
  }
  await reader.cancel().catch(() => {});
}

async function seedSession(app: ReturnType<typeof createTestApp>["app"], agentStore: InMemoryAgentStore, sessionStore: InMemorySessionStore) {
  const agent = await agentStore.create({
    tenantId: "dev",
    name: "A",
    model: "m",
    system: "s",
    runtime: "claude-code",
  });
  const session = await sessionStore.create({ tenantId: "dev", agentId: agent.id, agent, workspaceId: "ws_test" });
  return session;
}

async function sendMessage(app: ReturnType<typeof createTestApp>["app"], sessionId: string, content: unknown) {
  const res = await app.request(`/v1/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  await drain(res);
  return res;
}

describe("POST /v1/sessions/:id/messages — title snapshot", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("snapshots a title from the first message's text", async () => {
    const { app, agentStore, sessionStore } = createTestApp();
    const session = await seedSession(app, agentStore, sessionStore);

    await sendMessage(app, session.id, "Help me write a poem");

    const stored = await sessionStore.getById(session.id);
    expect(stored?.title).toBe("Help me write a poem");
  });

  it("does not overwrite the title on a second message", async () => {
    const { app, agentStore, sessionStore } = createTestApp();
    const session = await seedSession(app, agentStore, sessionStore);

    await sendMessage(app, session.id, "First message");
    await sendMessage(app, session.id, "Second message");

    const stored = await sessionStore.getById(session.id);
    expect(stored?.title).toBe("First message");
    // setTitle called exactly once (only the first send with an empty title).
    expect(sessionStore.setTitleCalls).toHaveLength(1);
  });

  it("truncates a long first message to 60 chars with an ellipsis", async () => {
    const { app, agentStore, sessionStore } = createTestApp();
    const session = await seedSession(app, agentStore, sessionStore);

    const long = "x".repeat(200);
    await sendMessage(app, session.id, long);

    const stored = await sessionStore.getById(session.id);
    expect(stored?.title).toBe("x".repeat(60) + "…");
  });

  it("collapses whitespace when deriving the title", async () => {
    const { app, agentStore, sessionStore } = createTestApp();
    const session = await seedSession(app, agentStore, sessionStore);

    await sendMessage(app, session.id, "  Hello\n\n   world  ");

    const stored = await sessionStore.getById(session.id);
    expect(stored?.title).toBe("Hello world");
  });

  it("does not set a title when the first block has no text", async () => {
    const { app, agentStore, sessionStore } = createTestApp();
    const session = await seedSession(app, agentStore, sessionStore);

    await sendMessage(app, session.id, [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
    ]);

    const stored = await sessionStore.getById(session.id);
    expect(stored?.title).toBeUndefined();
  });
});
