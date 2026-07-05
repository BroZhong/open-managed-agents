import { describe, it, expect } from "vitest";
import { SessionRouter } from "../src/session-router.js";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import type {
  TurnStreamStore,
  TurnDelta,
  StoredTurnDelta,
  ActiveTurn,
} from "@oma-server/redis";
import type {
  EventLogStore,
  EventLogStoreAppendInput,
  EventLogStoreGetEventsOpts,
  PendingEventStore,
  PendingEvent,
  PendingEventEnqueueInput,
  SessionStore,
  SessionStoreCreateInput,
  SessionStoreListOpts,
  Session,
  SessionStatus,
  StoredEvent,
  PaginatedResult,
  Agent,
} from "@oma-server/store";
import type {
  Adapter,
  AdapterInput,
  SessionEvent,
} from "@open-managed-agents/adapter-core";

// ─── In-memory EventLogStore (canonical log only) ────────────────────────────

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

// ─── In-memory PendingEventStore ─────────────────────────────────────────────

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

// ─── In-memory TurnStreamStore (Redis stand-in) ──────────────────────────────

class InMemoryTurnStreamStore implements TurnStreamStore {
  streams = new Map<string, StoredTurnDelta[]>();
  activeTurns = new Map<string, ActiveTurn>();
  /** Every delta ever appended, retained across reclaim() for assertions. */
  appendedDeltas: StoredTurnDelta[] = [];
  private seq = 0;

  async appendDelta(delta: TurnDelta): Promise<string> {
    const id = `0-${this.seq++}`;
    const list = this.streams.get(delta.turnId) ?? [];
    const stored = { ...delta, id };
    list.push(stored);
    this.streams.set(delta.turnId, list);
    this.appendedDeltas.push(stored);
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

// ─── In-memory SessionStore ──────────────────────────────────────────────────

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
    const filtered = this.sessions.filter((s) => s.tenantId === tenantId);
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

// ─── Mock adapter ────────────────────────────────────────────────────────────

function createMockAdapter(events: SessionEvent[]): Adapter {
  return {
    async *run(_input: AdapterInput): AsyncIterable<SessionEvent> {
      for (const event of events) {
        yield event;
      }
    },
  };
}

function createDelayedMockAdapter(events: SessionEvent[], delayMs: number): Adapter {
  return {
    async *run(_input: AdapterInput): AsyncIterable<SessionEvent> {
      for (const event of events) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        yield event;
      }
    },
  };
}

// ─── Test helpers ────────────────────────────────────────────────────────────

const testAgent: Agent = {
  id: "agent_1",
  tenantId: "tenant_1",
  name: "Test Agent",
  model: "claude-3",
  system: "You are helpful",
  runtime: "claude-code",
  // Explicitly opt out of the mandatory sandbox (issue #54): these tests
  // exercise the non-sandbox drain flow with no toolExecutorFactory, so the
  // agent must be opted-out to avoid the sandbox_unavailable fail-loud path.
  sandbox: { enabled: false },
  createdAt: new Date(),
  updatedAt: new Date(),
};

function createTestDeps(adapter: Adapter) {
  const eventLogStore = new InMemoryEventLogStore();
  const pendingEventStore = new InMemoryPendingEventStore();
  const sessionStore = new InMemorySessionStore();
  const eventStreamHub = new InProcessEventStreamHub();

  const router = new SessionRouter({
    eventLogStore,
    pendingEventStore,
    sessionStore,
    eventStreamHub,
    resolveAdapter: () => adapter,
  });

  return { eventLogStore, pendingEventStore, sessionStore, eventStreamHub, router };
}

function createTestDepsWithTurnStream(adapter: Adapter) {
  const eventLogStore = new InMemoryEventLogStore();
  const pendingEventStore = new InMemoryPendingEventStore();
  const sessionStore = new InMemorySessionStore();
  const eventStreamHub = new InProcessEventStreamHub();
  const turnStreamStore = new InMemoryTurnStreamStore();

  const router = new SessionRouter({
    eventLogStore,
    pendingEventStore,
    sessionStore,
    eventStreamHub,
    turnStreamStore,
    resolveAdapter: () => adapter,
  });

  return { eventLogStore, pendingEventStore, sessionStore, eventStreamHub, turnStreamStore, router };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("SessionRouter", () => {
  describe("handleNewEvent - basic flow", () => {
    it("processes a pending user.message, promotes to canonical log, runs adapter", async () => {
      const canonicalEvents: SessionEvent[] = [
        {
          id: "evt_1",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text: "Hello back!" }],
        },
      ];

      const adapter = createMockAdapter(canonicalEvents);
      const { eventLogStore, pendingEventStore, sessionStore, router } = createTestDeps(adapter);

      const session = await sessionStore.create({
        tenantId: "tenant_1",
        agentId: "agent_1",
        agent: testAgent,
        workspaceId: "ws_test",
      });

      // Enqueue a user.message into pending
      await pendingEventStore.enqueue(session.id, {
        type: "user.message",
        data: { content: [{ type: "text", text: "Hello" }] },
        sessionThreadId: "sthr_primary",
      });

      await router.handleNewEvent(session.id, testAgent);

      // Verify session ends as idle
      const updatedSession = await sessionStore.getById(session.id);
      expect(updatedSession!.status).toBe("idle");

      // Verify events in canonical log:
      // seq 1: user.message (promoted from pending)
      // seq 2: session.status_running
      // seq 3: agent.message (from adapter)
      // seq 4: session.status_idle
      const allEvents = await eventLogStore.getEvents(session.id, { limit: 100 });
      expect(allEvents.data.length).toBe(4);
      expect(allEvents.data[0].type).toBe("user.message");
      expect(allEvents.data[1].type).toBe("session.status_running");
      expect(allEvents.data[2].type).toBe("agent.message");
      expect(allEvents.data[3].type).toBe("session.status_idle");

      // Verify pending queue is empty
      expect(await pendingEventStore.count(session.id)).toBe(0);
    });
  });

  describe("handleNewEvent - pending drain with multiple messages", () => {
    it("drains multiple pending messages in sequence", async () => {
      let callCount = 0;
      const adapter: Adapter = {
        async *run(_input: AdapterInput): AsyncIterable<SessionEvent> {
          callCount++;
          yield {
            id: `evt_${callCount}`,
            timestamp: "2024-01-01T00:00:00.000Z",
            type: "agent.message",
            content: [{ type: "text", text: `Reply ${callCount}` }],
          };
        },
      };

      const { eventLogStore, pendingEventStore, sessionStore, router } = createTestDeps(adapter);

      const session = await sessionStore.create({
        tenantId: "tenant_1",
        agentId: "agent_1",
        agent: testAgent,
        workspaceId: "ws_test",
      });

      // Enqueue two pending messages
      await pendingEventStore.enqueue(session.id, {
        type: "user.message",
        data: { content: [{ type: "text", text: "First" }] },
        sessionThreadId: "sthr_primary",
      });
      await pendingEventStore.enqueue(session.id, {
        type: "user.message",
        data: { content: [{ type: "text", text: "Second" }] },
        sessionThreadId: "sthr_primary",
      });

      await router.handleNewEvent(session.id, testAgent);

      // Adapter should have been called twice
      expect(callCount).toBe(2);

      // Verify correct event ordering in canonical log
      const allEvents = await eventLogStore.getEvents(session.id, { limit: 100 });
      const types = allEvents.data.map((e) => e.type);

      // Expected: user.message, status_running, agent.message, user.message, status_running, agent.message, status_idle
      expect(types.filter((t) => t === "user.message")).toHaveLength(2);
      expect(types.filter((t) => t === "agent.message")).toHaveLength(2);
      expect(types.filter((t) => t === "session.status_running")).toHaveLength(2);
      expect(types.filter((t) => t === "session.status_idle")).toHaveLength(1);

      // Verify pending queue is drained
      expect(await pendingEventStore.count(session.id)).toBe(0);
    });
  });

  describe("handleNewEvent - chunk events", () => {
    it("publishes chunk events to hub but does not persist them", async () => {
      const events: SessionEvent[] = [
        {
          id: "evt_stream_start",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message_stream_start",
        },
        {
          id: "evt_chunk_1",
          timestamp: "2024-01-01T00:00:01.000Z",
          type: "agent.message_chunk",
          text: "Hello",
        },
        {
          id: "evt_canonical",
          timestamp: "2024-01-01T00:00:04.000Z",
          type: "agent.message",
          content: [{ type: "text", text: "Hello world" }],
        },
      ];

      const adapter = createMockAdapter(events);
      const { eventLogStore, pendingEventStore, sessionStore, eventStreamHub, router } = createTestDeps(adapter);

      const session = await sessionStore.create({
        tenantId: "tenant_1",
        agentId: "agent_1",
        agent: testAgent,
        workspaceId: "ws_test",
      });

      await pendingEventStore.enqueue(session.id, {
        type: "user.message",
        data: { content: [{ type: "text", text: "Hello" }] },
        sessionThreadId: "sthr_primary",
      });

      // Subscribe to collect published chunks
      const publishedChunks: string[] = [];
      const { stream, unsubscribe } = eventStreamHub.subscribe(session.id, { includeChunks: true });
      const reader = stream.getReader();

      const readPromise = (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            publishedChunks.push(value);
          }
        } catch {
          // cancelled
        }
      })();

      await router.handleNewEvent(session.id, testAgent);

      await new Promise((resolve) => setTimeout(resolve, 10));
      unsubscribe();
      await readPromise.catch(() => {});

      // Verify chunk events were published
      const chunkFrames = publishedChunks.filter((c) => c.includes("agent.message_chunk"));
      expect(chunkFrames.length).toBeGreaterThan(0);

      // Verify chunk events are NOT in the canonical log
      const allEvents = await eventLogStore.getEvents(session.id, { limit: 100 });
      const storedTypes = allEvents.data.map((e) => e.type);
      expect(storedTypes).not.toContain("agent.message_stream_start");
      expect(storedTypes).not.toContain("agent.message_chunk");

      // But canonical event IS persisted
      expect(storedTypes).toContain("agent.message");
    });
  });

  describe("interrupt", () => {
    it("aborts the adapter run", async () => {
      const events: SessionEvent[] = [
        {
          id: "evt_1",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message_stream_start",
        },
        {
          id: "evt_2",
          timestamp: "2024-01-01T00:00:01.000Z",
          type: "agent.message_chunk",
          text: "This should not complete",
        },
        {
          id: "evt_3",
          timestamp: "2024-01-01T00:00:03.000Z",
          type: "agent.message",
          content: [{ type: "text", text: "This should not complete" }],
        },
      ];

      const adapter = createDelayedMockAdapter(events, 50);
      const { pendingEventStore, sessionStore, eventLogStore, router } = createTestDeps(adapter);

      const session = await sessionStore.create({
        tenantId: "tenant_1",
        agentId: "agent_1",
        agent: testAgent,
        workspaceId: "ws_test",
      });

      await pendingEventStore.enqueue(session.id, {
        type: "user.message",
        data: { content: [{ type: "text", text: "Hello" }] },
        sessionThreadId: "sthr_primary",
      });

      const processPromise = router.handleNewEvent(session.id, testAgent);

      await new Promise((resolve) => setTimeout(resolve, 30));
      router.interrupt(session.id);

      await processPromise;

      // Verify the canonical message was NOT persisted (interrupted before it)
      const allEvents = await eventLogStore.getEvents(session.id, { limit: 100 });
      const storedTypes = allEvents.data.map((e) => e.type);
      expect(storedTypes).not.toContain("agent.message");
    });
  });

  describe("handleNewEvent - no-op when already running", () => {
    it("returns immediately if session is already being processed", async () => {
      const events: SessionEvent[] = [
        {
          id: "evt_1",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text: "Reply" }],
        },
      ];

      const adapter = createDelayedMockAdapter(events, 50);
      const { pendingEventStore, sessionStore, eventLogStore, router } = createTestDeps(adapter);

      const session = await sessionStore.create({
        tenantId: "tenant_1",
        agentId: "agent_1",
        agent: testAgent,
        workspaceId: "ws_test",
      });

      await pendingEventStore.enqueue(session.id, {
        type: "user.message",
        data: { content: [{ type: "text", text: "Hello" }] },
        sessionThreadId: "sthr_primary",
      });

      const first = router.handleNewEvent(session.id, testAgent);
      const second = router.handleNewEvent(session.id, testAgent);

      await Promise.all([first, second]);

      const allEvents = await eventLogStore.getEvents(session.id, { limit: 100 });
      const agentMessages = allEvents.data.filter((e) => e.type === "agent.message");
      expect(agentMessages).toHaveLength(1);
    });
  });

  describe("turn stream (delta→Redis, full→PostgreSQL, active-turn map)", () => {
    const streamingEvents: SessionEvent[] = [
      { id: "s0", timestamp: "2024-01-01T00:00:00.000Z", type: "agent.message_stream_start" },
      { id: "s1", timestamp: "2024-01-01T00:00:01.000Z", type: "agent.message_chunk", text: "Hel" },
      { id: "s2", timestamp: "2024-01-01T00:00:02.000Z", type: "agent.message_chunk", text: "lo" },
      { id: "s3", timestamp: "2024-01-01T00:00:03.000Z", type: "agent.message_stream_end" },
      {
        id: "s4",
        timestamp: "2024-01-01T00:00:04.000Z",
        type: "agent.message",
        content: [{ type: "text", text: "Hello" }],
      },
    ];

    async function runOneTurn() {
      const adapter = createMockAdapter(streamingEvents);
      const deps = createTestDepsWithTurnStream(adapter);
      const session = await deps.sessionStore.create({
        tenantId: "tenant_1",
        agentId: "agent_1",
        agent: testAgent,
        workspaceId: "ws_test",
      });
      await deps.pendingEventStore.enqueue(session.id, {
        type: "user.message",
        data: { content: [{ type: "text", text: "Hi" }] },
        sessionThreadId: "sthr_primary",
      });
      await deps.router.handleNewEvent(session.id, testAgent);
      return { ...deps, session };
    }

    it("writes deltas to the per-turn Redis stream, never to PostgreSQL", async () => {
      const { eventLogStore, turnStreamStore, session } = await runOneTurn();

      // Deltas were written to the per-turn Redis stream (turnId is
      // turn_<seq of promoted user.message> => turn_1). We assert against the
      // retained append log because the live stream is reclaimed at turn end.
      const deltas = turnStreamStore.appendedDeltas.filter((d) => d.turnId === "turn_1");
      const deltaTypes = deltas.map((d) => d.type);
      expect(deltaTypes).toContain("agent.message_chunk");
      expect(deltaTypes).toContain("agent.message_stream_start");

      // Deltas carry the turnId + blockIndex alignment.
      const chunk = deltas.find((d) => d.type === "agent.message_chunk")!;
      expect(chunk.turnId).toBe("turn_1");
      expect(chunk.blockIndex).toBe(0);

      // PostgreSQL (canonical log) holds the full agent.message but NO deltas.
      const stored = await eventLogStore.getEvents(session.id, { limit: 100 });
      const storedTypes = stored.data.map((e) => e.type);
      expect(storedTypes).toContain("agent.message");
      expect(storedTypes).not.toContain("agent.message_chunk");
      expect(storedTypes).not.toContain("agent.message_stream_start");
      expect(storedTypes).not.toContain("agent.message_stream_end");
    });

    it("aligns deltas and their full event via turnId + blockIndex", async () => {
      const { turnStreamStore } = await runOneTurn();
      const deltas = turnStreamStore.appendedDeltas.filter((d) => d.turnId === "turn_1");
      // All message-block deltas share (turn_1, blockIndex 0), which is the same
      // pair the full agent.message would carry.
      for (const d of deltas) {
        expect(d.turnId).toBe("turn_1");
        expect(d.blockIndex).toBe(0);
      }
    });

    it("reclaims the per-turn Redis stream after the turn completes", async () => {
      const { turnStreamStore } = await runOneTurn();
      // The stream was reclaimed (DEL) at turn end.
      expect(await turnStreamStore.deltaCount("turn_1")).toBe(0);
      expect(await turnStreamStore.readDeltas("turn_1")).toEqual([]);
    });

    it("records the active turn in Redis and clears it when the session goes idle", async () => {
      const { turnStreamStore, session } = await runOneTurn();
      // Drain loop ended => active-turn record cleared.
      expect(await turnStreamStore.getActiveTurn(session.id)).toBeNull();
    });

    it("marks the active turn running mid-flight so a reconnect can find it", async () => {
      // A slow adapter lets us observe the active-turn map while the turn runs.
      const slow: Adapter = {
        async *run(): AsyncIterable<SessionEvent> {
          yield { id: "s0", timestamp: "t", type: "agent.message_stream_start" };
          yield { id: "s1", timestamp: "t", type: "agent.message_chunk", text: "Hel" };
          await new Promise((r) => setTimeout(r, 50));
          yield { id: "s2", timestamp: "t", type: "agent.message_chunk", text: "lo" };
          yield { id: "s3", timestamp: "t", type: "agent.message_stream_end" };
          yield {
            id: "s4",
            timestamp: "t",
            type: "agent.message",
            content: [{ type: "text", text: "Hello" }],
          };
        },
      };
      const deps = createTestDepsWithTurnStream(slow);
      const session = await deps.sessionStore.create({
        tenantId: "tenant_1",
        agentId: "agent_1",
        agent: testAgent,
        workspaceId: "ws_test",
      });
      await deps.pendingEventStore.enqueue(session.id, {
        type: "user.message",
        data: { content: [{ type: "text", text: "Hi" }] },
        sessionThreadId: "sthr_primary",
      });

      const run = deps.router.handleNewEvent(session.id, testAgent);

      // Mid-turn: active turn is running and half-emitted deltas are buffered.
      await new Promise((r) => setTimeout(r, 20));
      const active = await deps.turnStreamStore.getActiveTurn(session.id);
      expect(active).toEqual({ turnId: "turn_1", status: "running" });
      const midDeltas = await deps.turnStreamStore.readDeltas("turn_1");
      expect(midDeltas.some((d) => d.type === "agent.message_chunk")).toBe(true);

      await run;
    });
  });
});
