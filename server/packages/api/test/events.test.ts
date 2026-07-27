import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { createApp } from "../src/app.js";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { InMemoryTurnStreamStore } from "@oma-server/redis";
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

  setTitleCalls: Array<{ id: string; title: string }> = [];

  async setTitle(id: string, title: string): Promise<Session | null> {
    this.setTitleCalls.push({ id, title });
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

// In-memory EventLogStore for testing
class InMemoryEventLogStore implements EventLogIngressStore {
  private events: Map<string, StoredEvent[]> = new Map();
  private seqCounters: Map<string, number> = new Map();

  constructor(
    private readonly isSessionActive: (sessionId: string) => Promise<boolean> = async () => true,
  ) {}

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

  async appendIfSessionActive(
    sessionId: string,
    event: Pick<EventLogStoreAppendInput, "type" | "data" | "sessionThreadId">,
  ): Promise<StoredEvent | null> {
    if (!await this.isSessionActive(sessionId)) return null;
    return this.append(sessionId, event);
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
class InMemoryPendingEventStore implements PendingEventIngressStore {
  private queues: Map<string, PendingEvent[]> = new Map();
  private nextId = 1;

  constructor(
    private readonly isSessionActive: (sessionId: string) => Promise<boolean> = async () => true,
  ) {}

  async enqueue(sessionId: string, event: PendingEventEnqueueInput): Promise<PendingEvent> {
    const pending: PendingEvent = {
      id: `pending_${this.nextId++}`,
      sessionId,
      type: event.type,
      data: event.data,
      sessionThreadId: event.sessionThreadId,
      ...(event.apiKeyId ? { apiKeyId: event.apiKeyId } : {}),
      arrivedAt: new Date(),
    };
    const queue = this.queues.get(sessionId) ?? [];
    queue.push(pending);
    this.queues.set(sessionId, queue);
    return pending;
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
    const queue = this.queues.get(sessionId) ?? [];
    if (queue.length === 0) return null;
    return queue.shift()!;
  }

  async peek(sessionId: string): Promise<PendingEvent | null> {
    const queue = this.queues.get(sessionId) ?? [];
    return queue[0] ?? null;
  }

  async ack(sessionId: string, eventId: string): Promise<boolean> {
    const queue = this.queues.get(sessionId) ?? [];
    if (queue[0]?.id !== eventId) return false;
    queue.shift();
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
    const queue = this.queues.get(sessionId) ?? [];
    return queue.length;
  }
}

interface SSEFrame {
  event: string;
  id?: string;
  data: unknown;
}

/** Parse a chunk of SSE text into structured frames (ignores retry:/comments). */
function parseSSE(text: string): SSEFrame[] {
  const frames: SSEFrame[] = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let event: string | undefined;
    let id: string | undefined;
    let dataLine: string | undefined;
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice("event: ".length);
      else if (line.startsWith("id: ")) id = line.slice("id: ".length);
      else if (line.startsWith("data: ")) dataLine = line.slice("data: ".length);
    }
    if (event === undefined || dataLine === undefined) continue;
    let data: unknown = dataLine;
    try {
      data = JSON.parse(dataLine);
    } catch {
      // keep raw
    }
    frames.push({ event, id, data });
  }
  return frames;
}

/** Read `count` SSE frames (or until the stream/timeout ends) from a Response. */
async function readSSEFrames(res: Response, count: number, timeoutMs = 300): Promise<SSEFrame[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: SSEFrame[] = [];
  const deadline = Date.now() + timeoutMs;

  while (frames.length < count && Date.now() < deadline) {
    const readPromise = reader.read();
    const timeout = new Promise<{ done: true; value: undefined }>((resolve) =>
      setTimeout(() => resolve({ done: true, value: undefined }), deadline - Date.now()),
    );
    const { value, done } = await Promise.race([readPromise, timeout]);
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Parse only complete frames (terminated by a blank line).
    const lastSep = buffer.lastIndexOf("\n\n");
    if (lastSep >= 0) {
      const complete = buffer.slice(0, lastSep + 2);
      buffer = buffer.slice(lastSep + 2);
      frames.push(...parseSSE(complete));
    }
  }
  await reader.cancel().catch(() => {});
  return frames;
}

/** Read raw SSE bytes until `needle` arrives, or return null on timeout/end. */
async function readSSETextUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
  timeoutMs: number,
): Promise<string | null> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let text = "";

  while (Date.now() < deadline) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      reader.read().then((read) => ({ kind: "read" as const, read })),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: "timeout" }), deadline - Date.now());
      }),
    ]);
    if (timeout !== undefined) clearTimeout(timeout);
    if (result.kind === "timeout" || result.read.done) return null;
    text += decoder.decode(result.read.value, { stream: true });
    if (text.includes(needle)) return text;
  }

  return null;
}

function makeApiKeyStore(entries: Map<string, TenantContext>): ApiKeyStore {
  return {
    async findByKeyHash(keyHash) {
      return entries.get(keyHash) ?? null;
    },
  };
}

function createTestApp(
  sessionRouter?: SessionRouter,
  apiKeys: Map<string, TenantContext> = new Map(),
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
  const app = createApp({
    apiKeyStore: makeApiKeyStore(apiKeys),
    agentStore,
    sessionStore,
    eventLogStore,
    pendingEventStore,
    sessionRouter,
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
    workspaceId: "ws_test",
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
    expect(await res.json()).toEqual({ accepted: true, interrupted: false });

    // Verify message is in pending store
    const pending = await pendingEventStore.peek(session.id);
    expect(pending).not.toBeNull();
    expect(pending!.type).toBe("user.message");
  });

  it("forwards x-vfs-token only as transient sandbox env", async () => {
    const handleNewEvent = vi.fn(async () => {});
    const sessionRouter = { handleNewEvent } as unknown as SessionRouter;
    const { app, agentStore, sessionStore, pendingEventStore } = createTestApp(sessionRouter);
    const { session } = await createTestSession(agentStore, sessionStore);

    const res = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vfs-token": "user-vfs-token",
      },
      body: JSON.stringify({
        events: [{ type: "user.message", data: { text: "List assets" } }],
      }),
    });

    expect(res.status).toBe(202);
    expect(handleNewEvent).toHaveBeenCalledWith(session.id, session.agent, {
      VFS_TOKEN: "user-vfs-token",
    });
    expect(JSON.stringify(await pendingEventStore.peek(session.id))).not.toContain(
      "user-vfs-token",
    );
  });

  it("attributes queued events to the authenticating API key", async () => {
    const rawKey = "event-attribution-key";
    const hash = createHash("sha256").update(rawKey).digest("hex");
    const { app, agentStore, sessionStore, pendingEventStore } = createTestApp(
      undefined,
      new Map([[hash, { tenantId: "dev", apiKeyId: "key_events" }]]),
    );
    delete process.env.AUTH_DISABLED;
    const { session } = await createTestSession(agentStore, sessionStore);

    const res = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": rawKey },
      body: JSON.stringify({
        events: [{ type: "user.message", data: { text: "Hello" } }],
      }),
    });

    expect(res.status).toBe(202);
    expect((await pendingEventStore.peek(session.id))?.apiKeyId).toBe("key_events");
  });

  it("returns 410 for a terminated Session without enqueuing input", async () => {
    const handleNewEvent = vi.fn(async () => {});
    const sessionRouter = { handleNewEvent } as unknown as SessionRouter;
    const { app, agentStore, sessionStore, pendingEventStore } = createTestApp(sessionRouter);
    const { session } = await createTestSession(agentStore, sessionStore);
    await sessionStore.terminate(session.id);

    const res = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [{ type: "user.message", data: { text: "too late" } }],
      }),
    });

    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "Session is terminated" });
    expect(await pendingEventStore.count(session.id)).toBe(0);
    expect(handleNewEvent).not.toHaveBeenCalled();
  });

  it("atomically rejects input when termination wins after the initial API read", async () => {
    const handleNewEvent = vi.fn(async () => {});
    const sessionRouter = { handleNewEvent } as unknown as SessionRouter;
    const { app, agentStore, sessionStore, pendingEventStore } = createTestApp(sessionRouter);
    const { session } = await createTestSession(agentStore, sessionStore);
    const enqueue = pendingEventStore.enqueueBatchIfSessionActive.bind(pendingEventStore);
    pendingEventStore.enqueueBatchIfSessionActive = vi.fn(async (sessionId, events) => {
      await sessionStore.terminate(sessionId);
      return enqueue(sessionId, events);
    });

    const res = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [{ type: "user.message", data: { text: "lost race" } }],
      }),
    });

    expect(res.status).toBe(410);
    expect(await pendingEventStore.count(session.id)).toBe(0);
    expect(handleNewEvent).not.toHaveBeenCalled();
  });

  it("keeps accepted input pending and logs an asynchronous router failure", async () => {
    const failure = new Error("router failed after accept");
    const sessionRouter = {
      handleNewEvent: vi.fn(async () => {
        throw failure;
      }),
    } as unknown as SessionRouter;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, agentStore, sessionStore, pendingEventStore } = createTestApp(sessionRouter);
    const { session } = await createTestSession(agentStore, sessionStore);

    try {
      const res = await app.request(`/v1/sessions/${session.id}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          events: [{ type: "user.message", data: { text: "retain me" } }],
        }),
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(res.status).toBe(202);
      expect(await pendingEventStore.count(session.id)).toBe(1);
      expect(consoleError).toHaveBeenCalledWith(
        `SessionRouter failed after accepting input for ${session.id}:`,
        failure,
      );
    } finally {
      consoleError.mockRestore();
    }
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

  it("validates the whole batch before accepting any prefix", async () => {
    const handleNewEvent = vi.fn(async () => {});
    const sessionRouter = { handleNewEvent } as unknown as SessionRouter;
    const { app, agentStore, sessionStore, pendingEventStore } = createTestApp(sessionRouter);
    const { session } = await createTestSession(agentStore, sessionStore);

    const res = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [
          { type: "user.message", data: { text: "must not persist" } },
          { type: "agent.message", data: { text: "invalid" } },
        ],
      }),
    });

    expect(res.status).toBe(400);
    expect(await pendingEventStore.count(session.id)).toBe(0);
    expect((await sessionStore.getById(session.id))?.title).toBeUndefined();
    expect(handleNewEvent).not.toHaveBeenCalled();
  });

  it("rejects a mixed interrupt batch without interrupting or queueing", async () => {
    const interrupt = vi.fn();
    const handleNewEvent = vi.fn(async () => {});
    const sessionRouter = { interrupt, handleNewEvent } as unknown as SessionRouter;
    const { app, agentStore, sessionStore, pendingEventStore } = createTestApp(sessionRouter);
    const { session } = await createTestSession(agentStore, sessionStore);

    const res = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [
          { type: "user.message", data: { text: "must not stall" } },
          { type: "user.interrupt", data: {} },
        ],
      }),
    });

    expect(res.status).toBe(400);
    expect(await pendingEventStore.count(session.id)).toBe(0);
    expect(interrupt).not.toHaveBeenCalled();
    expect(handleNewEvent).not.toHaveBeenCalled();
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

  it("atomically rejects a direct event when termination wins after the initial read", async () => {
    const { app, agentStore, sessionStore, eventLogStore } = createTestApp();
    const { session } = await createTestSession(agentStore, sessionStore);
    const append = eventLogStore.appendIfSessionActive.bind(eventLogStore);
    eventLogStore.appendIfSessionActive = vi.fn(async (sessionId, event) => {
      await sessionStore.terminate(sessionId);
      return append(sessionId, event);
    });

    const res = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [{ type: "user.define_outcome", data: { outcome: "too late" } }],
      }),
    });

    expect(res.status).toBe(410);
    expect((await eventLogStore.getEvents(session.id)).data).toHaveLength(0);
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

describe("POST /v1/sessions/:id/events — title snapshot (#70)", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  async function send(app: ReturnType<typeof createTestApp>["app"], id: string, data: unknown) {
    return app.request(`/v1/sessions/${id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [{ type: "user.message", data }] }),
    });
  }

  it("sets the title from the first message's first text block (content shape)", async () => {
    const { app, agentStore, sessionStore } = createTestApp();
    const { session } = await createTestSession(agentStore, sessionStore);

    await send(app, session.id, { content: [{ type: "text", text: "Help me write a poem" }] });

    const stored = await sessionStore.getById(session.id);
    expect(stored?.title).toBe("Help me write a poem");
  });

  it("sets the title from the flat { text } shape too", async () => {
    const { app, agentStore, sessionStore } = createTestApp();
    const { session } = await createTestSession(agentStore, sessionStore);

    await send(app, session.id, { text: "你好你是谁" });

    const stored = await sessionStore.getById(session.id);
    expect(stored?.title).toBe("你好你是谁");
  });

  it("does not overwrite the title on a later message (set only once)", async () => {
    const { app, agentStore, sessionStore } = createTestApp();
    const { session } = await createTestSession(agentStore, sessionStore);

    await send(app, session.id, { content: [{ type: "text", text: "First message" }] });
    await send(app, session.id, { content: [{ type: "text", text: "Second message" }] });

    const stored = await sessionStore.getById(session.id);
    expect(stored?.title).toBe("First message");
    expect(sessionStore.setTitleCalls).toHaveLength(1);
  });

  it("a previously untitled session gets a title on its next first-eligible message", async () => {
    const { app, agentStore, sessionStore } = createTestApp();
    const { session } = await createTestSession(agentStore, sessionStore);

    // First message has no text block (not eligible) → no title yet.
    await send(app, session.id, { content: [{ type: "image", url: "x" }] });
    expect((await sessionStore.getById(session.id))?.title).toBeUndefined();

    // Next message carries text → title is derived now.
    await send(app, session.id, { content: [{ type: "text", text: "Now I have text" }] });
    expect((await sessionStore.getById(session.id))?.title).toBe("Now I have text");
    expect(sessionStore.setTitleCalls).toHaveLength(1);
  });

  it("truncates a long title to ~60 chars with an ellipsis", async () => {
    const { app, agentStore, sessionStore } = createTestApp();
    const { session } = await createTestSession(agentStore, sessionStore);

    await send(app, session.id, { content: [{ type: "text", text: "x".repeat(100) }] });

    const stored = await sessionStore.getById(session.id);
    expect(stored?.title).toBe("x".repeat(60) + "…");
  });

  it("collapses whitespace when deriving the title", async () => {
    const { app, agentStore, sessionStore } = createTestApp();
    const { session } = await createTestSession(agentStore, sessionStore);

    await send(app, session.id, {
      content: [{ type: "text", text: "  Hello\n\n   world  " }],
    });

    const stored = await sessionStore.getById(session.id);
    expect(stored?.title).toBe("Hello world");
  });

  it("does not set a title when the first block has no text", async () => {
    const { app, agentStore, sessionStore } = createTestApp();
    const { session } = await createTestSession(agentStore, sessionStore);

    await send(app, session.id, { content: [{ type: "text", text: "   " }] });

    const stored = await sessionStore.getById(session.id);
    expect(stored?.title).toBeUndefined();
    expect(sessionStore.setTitleCalls).toHaveLength(0);
  });

  it("titles from the first message when a batch carries several", async () => {
    const { app, agentStore, sessionStore } = createTestApp();
    const { session } = await createTestSession(agentStore, sessionStore);

    await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [
          { type: "user.message", data: { content: [{ type: "text", text: "Batch first" }] } },
          { type: "user.message", data: { content: [{ type: "text", text: "Batch second" }] } },
        ],
      }),
    });

    const stored = await sessionStore.getById(session.id);
    expect(stored?.title).toBe("Batch first");
    expect(sessionStore.setTitleCalls).toHaveLength(1);
  });

  it("a setTitle store failure does not block message send", async () => {
    const { app, agentStore, sessionStore, pendingEventStore } = createTestApp();
    const { session } = await createTestSession(agentStore, sessionStore);

    sessionStore.setTitle = async () => {
      throw new Error("db down");
    };

    const res = await send(app, session.id, {
      content: [{ type: "text", text: "still sends" }],
    });

    expect(res.status).toBe(202);
    // The message was still enqueued despite the title failure.
    expect(await pendingEventStore.count(session.id)).toBe(1);
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

  it("preserves tolerant parsing for invalid event pagination values", async () => {
    const { app, agentStore, sessionStore, eventLogStore } = createTestApp();
    const { session } = await createTestSession(agentStore, sessionStore);
    await eventLogStore.append(session.id, {
      type: "user.message",
      data: { text: "Hello" },
      sessionThreadId: "sthr_primary",
    });

    const res = await app.request(
      `/v1/sessions/${session.id}/events?after_seq=abc&limit=abc`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
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

describe("GET /v1/sessions/:id/events (SSE server-side reconnect merge)", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  function createMergeApp(sseHeartbeatIntervalMs?: number) {
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
    const turnStreamStore = new InMemoryTurnStreamStore();
    const app = createApp({
      apiKeyStore: makeApiKeyStore(new Map()),
      agentStore,
      sessionStore,
      eventLogStore,
      pendingEventStore,
      eventStreamHub,
      turnStreamStore,
      sseHeartbeatIntervalMs,
    });
    return { app, agentStore, sessionStore, eventLogStore, pendingEventStore, eventStreamHub, turnStreamStore };
  }

  it("keeps an idle SSE connection alive and still delivers a later durable event", async () => {
    const { app, agentStore, sessionStore, eventLogStore, eventStreamHub } = createMergeApp(10);
    const { session } = await createTestSession(agentStore, sessionStore);
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    let heartbeatTimerCleared = false;

    const res = await app.request(`/v1/sessions/${session.id}/events`, {
      headers: { accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    try {
      const heartbeat = await readSSETextUntil(reader, ": keepalive\n\n", 100);
      expect(heartbeat).toContain("retry: 1000\n\n");
      expect(heartbeat).toContain(": keepalive\n\n");

      const data = { type: "agent.message", content: [{ type: "text", text: "after idle" }] };
      const stored = await eventLogStore.append(session.id, {
        type: "agent.message",
        data,
        sessionThreadId: "sthr_primary",
      });
      eventStreamHub.publish(session.id, {
        type: "agent.message",
        seq: stored.seq,
        data,
      });

      const live = await readSSETextUntil(reader, "event: agent.message\n", 100);
      expect(live).toContain(`id: ${stored.seq}\n`);
      expect(live).toContain('"after idle"');
    } finally {
      await reader.cancel().catch(() => {});
      heartbeatTimerCleared = clearIntervalSpy.mock.calls.length > 0;
      clearIntervalSpy.mockRestore();
    }
    expect(heartbeatTimerCleared).toBe(true);
  });

  it("reconnect mid-turn: backfills PG completed events, then the half-emitted deltas, then continues live", async () => {
    const { app, agentStore, sessionStore, eventLogStore, eventStreamHub, turnStreamStore } =
      createMergeApp();
    const { session } = await createTestSession(agentStore, sessionStore);

    // PostgreSQL holds the turn's completed (structured) events so far.
    await eventLogStore.append(session.id, {
      type: "user.message",
      data: { content: [{ type: "text", text: "Hi" }] },
      sessionThreadId: "sthr_primary",
    });
    await eventLogStore.append(session.id, {
      type: "session.status_running",
      data: {},
      sessionThreadId: "sthr_primary",
    });

    // The turn is still running: Redis holds half-emitted deltas + active turn.
    await turnStreamStore.setActiveTurn(session.id, { turnId: "turn_1", status: "running" });
    await turnStreamStore.appendDelta({
      turnId: "turn_1",
      blockIndex: 0,
      type: "agent.message_chunk",
      data: { type: "agent.message_chunk", text: "Hel" },
    });
    await turnStreamStore.appendDelta({
      turnId: "turn_1",
      blockIndex: 0,
      type: "agent.message_chunk",
      data: { type: "agent.message_chunk", text: "lo" },
    });

    const res = await app.request(`/v1/sessions/${session.id}/events?replay=1&include=chunks`, {
      headers: { accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    // Push one more live delta AFTER the connection is open, simulating the turn
    // continuing. Give the start() replay a tick to run first.
    await new Promise((r) => setTimeout(r, 20));
    eventStreamHub.publishChunk(session.id, {
      type: "agent.message_chunk",
      data: { type: "agent.message_chunk", text: "!" },
      turnId: "turn_1",
      blockIndex: 0,
    });

    // Expect: 2 PG events + 2 backfilled deltas + 1 live delta = 5 frames.
    const frames = await readSSEFrames(res, 5, 400);

    const types = frames.map((f) => f.event);
    expect(types).toEqual([
      "user.message",
      "session.status_running",
      "agent.message_chunk",
      "agent.message_chunk",
      "agent.message_chunk",
    ]);

    // The backfilled deltas carry turnId + blockIndex and the token text.
    const backfilled = frames.slice(2, 4).map((f) => f.data as Record<string, unknown>);
    expect(backfilled[0]).toMatchObject({ turnId: "turn_1", blockIndex: 0, text: "Hel" });
    expect(backfilled[1]).toMatchObject({ turnId: "turn_1", blockIndex: 0, text: "lo" });

    // The live delta was NOT duplicated by the backfill (drop budget of 2 only
    // cancels the 2 backfilled tokens); the "!" continues the same block.
    const live = frames[4].data as Record<string, unknown>;
    expect(live).toMatchObject({ turnId: "turn_1", blockIndex: 0, text: "!" });
  });

  it("de-overlaps a live delta that duplicates a backfilled one (same Redis entry id)", async () => {
    const { app, agentStore, sessionStore, eventStreamHub, turnStreamStore } = createMergeApp();
    const { session } = await createTestSession(agentStore, sessionStore);

    await turnStreamStore.setActiveTurn(session.id, { turnId: "turn_1", status: "running" });
    // Two deltas buffered in Redis: ids 0-0, 0-1.
    const id0 = await turnStreamStore.appendDelta({
      turnId: "turn_1",
      blockIndex: 0,
      type: "agent.message_chunk",
      data: { type: "agent.message_chunk", text: "Hel" },
    });
    const id1 = await turnStreamStore.appendDelta({
      turnId: "turn_1",
      blockIndex: 0,
      type: "agent.message_chunk",
      data: { type: "agent.message_chunk", text: "lo" },
    });

    const res = await app.request(`/v1/sessions/${session.id}/events?replay=1&include=chunks`, {
      headers: { accept: "text/event-stream" },
    });

    await new Promise((r) => setTimeout(r, 20));
    // Re-publish the SECOND delta live (same entry id 0-1) — the overlap race —
    // then a genuinely new delta 0-2. Only the new one should reach the client.
    eventStreamHub.publishChunk(session.id, {
      type: "agent.message_chunk",
      data: { type: "agent.message_chunk", text: "lo" },
      turnId: "turn_1",
      blockIndex: 0,
      deltaId: id1,
    });
    eventStreamHub.publishChunk(session.id, {
      type: "agent.message_chunk",
      data: { type: "agent.message_chunk", text: "!" },
      turnId: "turn_1",
      blockIndex: 0,
      deltaId: "0-2",
    });

    // Backfill 2 (Hel, lo) + 1 genuinely-new live (!) = 3; the duplicated 0-1 is
    // skipped.
    const frames = await readSSEFrames(res, 3, 400);
    const texts = frames.map((f) => (f.data as { text: string }).text);
    expect(texts).toEqual(["Hel", "lo", "!"]);
    void id0;
  });

  it("reconnect after turn end: renders the full message from PG only, no delta backfill", async () => {
    const { app, agentStore, sessionStore, eventLogStore, turnStreamStore } = createMergeApp();
    const { session } = await createTestSession(agentStore, sessionStore);

    // Turn completed: full events persisted to PG, delta stream reclaimed, and
    // the active turn cleared (as SessionRouter does at turn end).
    await eventLogStore.append(session.id, {
      type: "user.message",
      data: { content: [{ type: "text", text: "Hi" }] },
      sessionThreadId: "sthr_primary",
    });
    await eventLogStore.append(session.id, {
      type: "agent.message",
      data: { type: "agent.message", content: [{ type: "text", text: "Hello!" }] },
      sessionThreadId: "sthr_primary",
    });
    await eventLogStore.append(session.id, {
      type: "session.status_idle",
      data: {},
      sessionThreadId: "sthr_primary",
    });
    // No active turn (cleared) and stream reclaimed.
    await turnStreamStore.reclaim("turn_1");

    const res = await app.request(`/v1/sessions/${session.id}/events?replay=1&include=chunks`, {
      headers: { accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);

    const frames = await readSSEFrames(res, 3, 300);
    const types = frames.map((f) => f.event);
    expect(types).toEqual(["user.message", "agent.message", "session.status_idle"]);

    // No delta frames whatsoever — reconnect after turn end is PG-only.
    expect(types.some((t) => t.endsWith("_chunk"))).toBe(false);
    const fullMsg = frames[1].data as { content: Array<{ text: string }> };
    expect(fullMsg.content[0].text).toBe("Hello!");
  });

  it("live persisted-event frame carries id:<seq> and the same data shape as replay (#71)", async () => {
    const { app, agentStore, sessionStore, eventLogStore, eventStreamHub, turnStreamStore } =
      createMergeApp();
    const { session } = await createTestSession(agentStore, sessionStore);

    // A turn already ran and is persisted to PG (the client will replay these).
    await eventLogStore.append(session.id, {
      type: "user.message",
      data: { content: [{ type: "text", text: "Hi" }] },
      sessionThreadId: "sthr_primary",
    });
    await eventLogStore.append(session.id, {
      type: "session.status_idle",
      data: {},
      sessionThreadId: "sthr_primary",
    });
    await turnStreamStore.reclaim("turn_1");

    // Client reconnects from the last replayed seq (2) — no active turn.
    const res = await app.request(
      `/v1/sessions/${session.id}/events?include=chunks`,
      { headers: { accept: "text/event-stream", "last-event-id": "2" } },
    );
    expect(res.status).toBe(200);

    // Simulate turn 2: the router promotes a new user.message, flips to running,
    // then emits a full agent.message — all persisted (so all carry a seq) and
    // published live on the same hub the SSE stream is subscribed to.
    await new Promise((r) => setTimeout(r, 20));
    for (const [type, data] of [
      ["user.message", { content: [{ type: "text", text: "again" }] }],
      ["session.status_running", {}],
      ["agent.message", { type: "agent.message", content: [{ type: "text", text: "ok" }] }],
      ["session.status_idle", {}],
    ] as const) {
      const stored = await eventLogStore.append(session.id, {
        type,
        data,
        sessionThreadId: "sthr_primary",
      });
      eventStreamHub.publish(session.id, { type, seq: stored.seq, data });
    }

    const frames = await readSSEFrames(res, 4, 400);
    const types = frames.map((f) => f.event);
    expect(types).toEqual([
      "user.message",
      "session.status_running",
      "agent.message",
      "session.status_idle",
    ]);

    // Every live persisted-event frame carries a real id:<seq> — never seq 0 —
    // so the client's seq-keyed dedup and Last-Event-ID resume both work.
    const ids = frames.map((f) => f.id);
    expect(ids).toEqual(["3", "4", "5", "6"]);
    expect(ids.every((id) => id !== undefined && id !== "0")).toBe(true);

    // The status_running frame's data is the same {} shape the replay path emits
    // (no divergent "one empty, one full" pair).
    const running = frames[1];
    expect(running.data).toEqual({});
  });

  it("does not backfill deltas for an idle active turn (turn already ended)", async () => {
    const { app, agentStore, sessionStore, eventLogStore, turnStreamStore } = createMergeApp();
    const { session } = await createTestSession(agentStore, sessionStore);

    await eventLogStore.append(session.id, {
      type: "agent.message",
      data: { type: "agent.message", content: [{ type: "text", text: "done" }] },
      sessionThreadId: "sthr_primary",
    });
    // Active turn marked idle (turn ended); any lingering deltas must be ignored.
    await turnStreamStore.setActiveTurn(session.id, { turnId: "turn_1", status: "idle" });
    await turnStreamStore.appendDelta({
      turnId: "turn_1",
      blockIndex: 0,
      type: "agent.message_chunk",
      data: { text: "stale" },
    });

    const res = await app.request(`/v1/sessions/${session.id}/events?replay=1&include=chunks`, {
      headers: { accept: "text/event-stream" },
    });
    const frames = await readSSEFrames(res, 2, 250);
    const types = frames.map((f) => f.event);
    expect(types).toEqual(["agent.message"]);
    expect(types.some((t) => t.endsWith("_chunk"))).toBe(false);
  });

  it("reconnect backfills ALL completed events past the seq, paging beyond one 1000-event batch (#95)", async () => {
    const { app, agentStore, sessionStore, eventLogStore } = createMergeApp();
    const { session } = await createTestSession(agentStore, sessionStore);

    // Seed 2500 completed events — well past the 1000-per-batch page size, so a
    // single query would silently drop the overflow (the bug this test guards).
    const TOTAL = 2500;
    for (let i = 0; i < TOTAL; i++) {
      await eventLogStore.append(session.id, {
        type: "agent.message",
        data: { type: "agent.message", content: [{ type: "text", text: `msg ${i + 1}` }] },
        sessionThreadId: "sthr_primary",
      });
    }

    // Reconnect from the very beginning (seq 0). No active turn, so the backfill
    // is PG-only and the stream just holds open for live afterwards.
    const res = await app.request(`/v1/sessions/${session.id}/events`, {
      headers: { accept: "text/event-stream", "last-event-id": "0" },
    });
    expect(res.status).toBe(200);

    // Read all 2500 backfilled frames.
    const frames = await readSSEFrames(res, TOTAL, 2000);

    // Correct count, contiguous seqs (1..2500), no gaps, no duplicates.
    expect(frames).toHaveLength(TOTAL);
    const seqs = frames.map((f) => Number(f.id));
    expect(seqs).toEqual(Array.from({ length: TOTAL }, (_, i) => i + 1));
    expect(new Set(seqs).size).toBe(TOTAL);
    expect(frames.every((f) => f.event === "agent.message")).toBe(true);
  });

  it("reconnect from a mid seq pages the remaining events, none before the seq (#95)", async () => {
    const { app, agentStore, sessionStore, eventLogStore } = createMergeApp();
    const { session } = await createTestSession(agentStore, sessionStore);

    const TOTAL = 2500;
    for (let i = 0; i < TOTAL; i++) {
      await eventLogStore.append(session.id, {
        type: "agent.message",
        data: { type: "agent.message", content: [{ type: "text", text: `msg ${i + 1}` }] },
        sessionThreadId: "sthr_primary",
      });
    }

    // Resume from a mid value spanning more than one page of remaining events.
    const AFTER = 900;
    const remaining = TOTAL - AFTER;
    const res = await app.request(`/v1/sessions/${session.id}/events`, {
      headers: { accept: "text/event-stream", "last-event-id": String(AFTER) },
    });
    expect(res.status).toBe(200);

    const frames = await readSSEFrames(res, remaining, 2000);

    expect(frames).toHaveLength(remaining);
    const seqs = frames.map((f) => Number(f.id));
    // Contiguous 901..2500 — nothing at or before AFTER, no gaps, no dupes.
    expect(seqs).toEqual(Array.from({ length: remaining }, (_, i) => AFTER + 1 + i));
    expect(Math.min(...seqs)).toBe(AFTER + 1);
    expect(new Set(seqs).size).toBe(remaining);
  });
});
