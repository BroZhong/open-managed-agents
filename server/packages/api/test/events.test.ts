import { describe, it, expect, beforeEach } from "vitest";
import { createApp } from "../src/app.js";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import type {
  TurnStreamStore,
  TurnDelta,
  StoredTurnDelta,
  ActiveTurn,
} from "@oma-server/redis";
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

// In-memory TurnStreamStore for testing the server-side reconnect merge.
class InMemoryTurnStreamStore implements TurnStreamStore {
  streams = new Map<string, StoredTurnDelta[]>();
  activeTurns = new Map<string, ActiveTurn>();
  private seq = 0;

  async appendDelta(delta: TurnDelta): Promise<string> {
    const id = `0-${this.seq++}`;
    const list = this.streams.get(delta.turnId) ?? [];
    list.push({ ...delta, id });
    this.streams.set(delta.turnId, list);
    return id;
  }

  async readDeltas(turnId: string, afterId?: string): Promise<StoredTurnDelta[]> {
    const list = this.streams.get(turnId) ?? [];
    if (!afterId) return [...list];
    const idx = list.findIndex((d) => d.id === afterId);
    return list.slice(idx + 1);
  }

  async deltaCount(turnId: string): Promise<number> {
    return this.streams.get(turnId)?.length ?? 0;
  }

  async reclaim(turnId: string): Promise<void> {
    this.streams.delete(turnId);
  }

  async setActiveTurn(sessionId: string, turn: ActiveTurn): Promise<void> {
    this.activeTurns.set(sessionId, { ...turn });
  }

  async getActiveTurn(sessionId: string): Promise<ActiveTurn | null> {
    return this.activeTurns.get(sessionId) ?? null;
  }

  async clearActiveTurn(sessionId: string): Promise<void> {
    this.activeTurns.delete(sessionId);
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

describe("GET /v1/sessions/:id/events (SSE server-side reconnect merge)", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  function createMergeApp() {
    process.env.AUTH_DISABLED = "true";
    const agentStore = new InMemoryAgentStore();
    const sessionStore = new InMemorySessionStore();
    const eventLogStore = new InMemoryEventLogStore();
    const pendingEventStore = new InMemoryPendingEventStore();
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
    });
    return { app, agentStore, sessionStore, eventLogStore, pendingEventStore, eventStreamHub, turnStreamStore };
  }

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
});
