import { describe, it, expect, beforeEach, vi } from "vitest";
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
  EventLogIngressStore,
  EventLogStoreAppendInput,
  EventLogStoreGetEventsOpts,
  PendingEventIngressStore,
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

class InMemoryEventLogStore implements EventLogIngressStore {
  private events = new Map<string, StoredEvent[]>();
  private seq = new Map<string, number>();

  constructor(
    private readonly isSessionActive: (sessionId: string) => Promise<boolean> = async () => true,
  ) {}
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
  async appendIfSessionActive(
    sessionId: string,
    event: Pick<EventLogStoreAppendInput, "type" | "data" | "sessionThreadId">,
  ): Promise<StoredEvent | null> {
    if (!await this.isSessionActive(sessionId)) return null;
    return this.append(sessionId, event);
  }
  async getEvents(sessionId: string, opts?: EventLogStoreGetEventsOpts): Promise<PaginatedResult<StoredEvent>> {
    const all = this.events.get(sessionId) ?? [];
    const after = opts?.afterSeq ?? 0;
    return { data: all.filter((e) => e.seq > after), hasMore: false };
  }
}

class InMemoryPendingEventStore implements PendingEventIngressStore {
  private queues = new Map<string, PendingEvent[]>();
  private nextId = 1;

  constructor(
    private readonly isSessionActive: (sessionId: string) => Promise<boolean> = async () => true,
  ) {}
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

  async enqueueBatchIfSessionActive(
    sessionId: string,
    events: PendingEventEnqueueInput[],
  ): Promise<PendingEvent[] | null> {
    if (!await this.isSessionActive(sessionId)) return null;
    const inserted: PendingEvent[] = [];
    for (const event of events) inserted.push(await this.enqueue(sessionId, event));
    return inserted;
  }
  async dequeue(sessionId: string): Promise<PendingEvent | null> {
    const q = this.queues.get(sessionId) ?? [];
    return q.shift() ?? null;
  }
  async peek(sessionId: string): Promise<PendingEvent | null> {
    return (this.queues.get(sessionId) ?? [])[0] ?? null;
  }
  async ack(sessionId: string, eventId: string): Promise<boolean> {
    const q = this.queues.get(sessionId) ?? [];
    if (q[0]?.id !== eventId) return false;
    q.shift();
    return true;
  }
  async listPendingSessionIds(): Promise<string[]> {
    return [...this.queues.entries()]
      .filter(([, queue]) => queue.length > 0)
      .map(([sessionId]) => sessionId);
  }
  async clear(sessionId: string): Promise<void> {
    this.queues.delete(sessionId);
  }
  async count(sessionId: string): Promise<number> {
    return (this.queues.get(sessionId) ?? []).length;
  }
}

function makeApiKeyStore(entries: Map<string, TenantContext>): ApiKeyStore {
  return { async findByKeyHash(keyHash) { return entries.get(keyHash) ?? null; } };
}

function createTestApp(
  routerFactory?: (ctx: {
    eventStreamHub: InProcessEventStreamHub;
    pendingEventStore: InMemoryPendingEventStore;
  }) => SessionRouter,
) {
  process.env.AUTH_DISABLED = "true";
  const agentStore = new InMemoryAgentStore();
  const sessionStore = new InMemorySessionStore();
  const eventLogStore = new InMemoryEventLogStore(async (sessionId) => {
    const current = await sessionStore.getById(sessionId);
    return Boolean(current && current.status !== "terminated");
  });
  const pendingEventStore = new InMemoryPendingEventStore(async (sessionId) => {
    const current = await sessionStore.getById(sessionId);
    return Boolean(current && current.status !== "terminated");
  });
  const eventStreamHub = new InProcessEventStreamHub();
  // Fake router: completes and acknowledges the accepted pending input so the
  // legacy streaming endpoint has the same terminal boundary as production.
  const sessionRouter = routerFactory?.({ eventStreamHub, pendingEventStore }) ?? ({
    async handleNewEvent(sessionId: string) {
      setTimeout(async () => {
        const pending = await pendingEventStore.dequeue(sessionId);
        if (!pending) return;
        eventStreamHub.publish(sessionId, {
          type: "session.turn_completed",
          data: { pendingEventId: pending.id },
        });
      }, 5);
    },
  } as unknown as SessionRouter);
  const app = createApp({
    apiKeyStore: makeApiKeyStore(new Map()),
    agentStore,
    sessionStore,
    eventLogStore,
    pendingEventStore,
    eventStreamHub,
    sessionRouter,
  });
  return { app, agentStore, sessionStore, pendingEventStore, eventStreamHub, sessionRouter };
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

describe("POST /v1/sessions/:id/messages — lifecycle", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("returns 410 for a terminated Session without enqueuing input", async () => {
    const handleNewEvent = vi.fn(async () => {});
    const { app, agentStore, sessionStore, pendingEventStore } = createTestApp(
      () => ({ handleNewEvent } as unknown as SessionRouter),
    );
    const session = await seedSession(app, agentStore, sessionStore);
    await sessionStore.terminate(session.id);

    const res = await app.request(`/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "too late" }),
    });

    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "Session is terminated" });
    expect(await pendingEventStore.count(session.id)).toBe(0);
    expect(handleNewEvent).not.toHaveBeenCalled();
  });

  it("atomically rejects a message when termination wins after the initial API read", async () => {
    const handleNewEvent = vi.fn(async () => {});
    const { app, agentStore, sessionStore, pendingEventStore } = createTestApp(
      () => ({ handleNewEvent } as unknown as SessionRouter),
    );
    const session = await seedSession(app, agentStore, sessionStore);
    const enqueue = pendingEventStore.enqueueBatchIfSessionActive.bind(pendingEventStore);
    pendingEventStore.enqueueBatchIfSessionActive = vi.fn(async (sessionId, events) => {
      await sessionStore.terminate(sessionId);
      return enqueue(sessionId, events);
    });

    const res = await app.request(`/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "lost race" }),
    });

    expect(res.status).toBe(410);
    expect(await pendingEventStore.count(session.id)).toBe(0);
    expect(handleNewEvent).not.toHaveBeenCalled();
  });

  it("keeps accepted input pending and logs an asynchronous router failure", async () => {
    const failure = new Error("router failed after accept");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, agentStore, sessionStore, pendingEventStore } = createTestApp(
      () => ({
        async handleNewEvent() {
          throw failure;
        },
      } as unknown as SessionRouter),
    );
    const session = await seedSession(app, agentStore, sessionStore);

    try {
      const res = await app.request(`/v1/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "retain me" }),
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(res.status).toBe(200);
      expect(await pendingEventStore.count(session.id)).toBe(1);
      expect(consoleError).toHaveBeenCalledWith(
        `SessionRouter failed after accepting input for ${session.id}:`,
        failure,
      );
      await res.body?.cancel();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("subscribes before enqueue so an existing drainer cannot outrun completion", async () => {
    const { app, agentStore, sessionStore, pendingEventStore, eventStreamHub } = createTestApp(
      () => ({ async handleNewEvent() {} } as unknown as SessionRouter),
    );
    const session = await seedSession(app, agentStore, sessionStore);
    const enqueue = pendingEventStore.enqueueBatchIfSessionActive.bind(pendingEventStore);
    pendingEventStore.enqueueBatchIfSessionActive = vi.fn(async (sessionId, events) => {
      const inserted = await enqueue(sessionId, events);
      if (inserted?.[0]) {
        // Model a drainer that was already running before this HTTP request:
        // it can promote the new tail and publish before enqueue returns.
        eventStreamHub.publish(sessionId, {
          type: "session.turn_completed",
          data: { pendingEventId: inserted[0].id },
        });
      }
      return inserted;
    });

    const response = await app.request(`/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "instant second turn" }),
    });
    const completed = await Promise.race([
      response.text().then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);

    expect(completed).toBe(true);
  });

  it("keeps a queued request open until its own pending input completes", async () => {
    const { app, agentStore, sessionStore, pendingEventStore, eventStreamHub } = createTestApp(
      () => ({ async handleNewEvent() {} } as unknown as SessionRouter),
    );
    const session = await seedSession(app, agentStore, sessionStore);

    const post = (content: string) => app.request(`/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    const firstResponse = await post("first queued turn");
    const firstPending = await pendingEventStore.peek(session.id);
    expect(firstPending).not.toBeNull();

    const secondResponse = await post("second queued turn");
    expect(await pendingEventStore.count(session.id)).toBe(2);

    const firstBody = firstResponse.text();
    const secondBody = secondResponse.text();
    const settlesWithin = async (promise: Promise<unknown>, ms = 30) =>
      Promise.race([
        promise.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), ms)),
      ]);

    // The idle boundary between Turns and the first request's completion are
    // visible to both subscribers. Only the first response may close.
    eventStreamHub.publish(session.id, { type: "session.status_idle", data: {} });
    eventStreamHub.publish(session.id, {
      type: "session.turn_completed",
      data: { pendingEventId: firstPending!.id },
    });
    expect(await settlesWithin(firstBody)).toBe(true);
    expect(await settlesWithin(secondBody)).toBe(false);

    expect(await pendingEventStore.dequeue(session.id)).toEqual(firstPending);
    const secondPending = await pendingEventStore.peek(session.id);
    expect(secondPending).not.toBeNull();
    eventStreamHub.publish(session.id, {
      type: "session.turn_completed",
      data: { pendingEventId: secondPending!.id },
    });
    expect(await settlesWithin(secondBody)).toBe(true);
  });
});

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
