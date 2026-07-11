import { describe, it, expect, vi } from "vitest";
import { SessionRouter } from "../src/session-router.js";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import {
  createMemoryStores,
  InMemoryEventLogStore as DurableInMemoryEventLogStore,
} from "@oma-server/store-memory";
import { InMemoryTurnStreamStore } from "@oma-server/redis";
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

// ─── Minimal in-memory stores (mirrors session-router.test.ts) ───────────────

class InMemoryEventLogStore implements EventLogStore {
  private events = new Map<string, StoredEvent[]>();
  private seqCounters = new Map<string, number>();

  async append(sessionId: string, event: EventLogStoreAppendInput): Promise<StoredEvent> {
    const nextSeq = (this.seqCounters.get(sessionId) ?? 0) + 1;
    this.seqCounters.set(sessionId, nextSeq);
    const stored: StoredEvent = {
      sessionId,
      seq: nextSeq,
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

  async getEvents(
    sessionId: string,
    opts?: EventLogStoreGetEventsOpts,
  ): Promise<PaginatedResult<StoredEvent>> {
    const all = this.events.get(sessionId) ?? [];
    const afterSeq = opts?.afterSeq ?? 0;
    const limit = opts?.limit ?? 50;
    const filtered = all.filter((e) => e.seq > afterSeq);
    return { data: filtered.slice(0, limit), hasMore: filtered.length > limit };
  }
}

class InMemoryPendingEventStore implements PendingEventStore {
  private queues = new Map<string, PendingEvent[]>();
  private nextId = 1;
  duplicateListedSessions = false;
  failNextAck = false;
  /** Test-only queue boundary hook: runs after an empty head read is observed. */
  onEmptyRead?: (sessionId: string) => Promise<void>;

  private async notifyEmptyRead(sessionId: string): Promise<void> {
    if (!this.onEmptyRead) return;
    const hook = this.onEmptyRead;
    this.onEmptyRead = undefined;
    await hook(sessionId);
  }

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
    const next = queue.shift() ?? null;
    if (!next) await this.notifyEmptyRead(sessionId);
    return next;
  }

  async peek(sessionId: string): Promise<PendingEvent | null> {
    const next = (this.queues.get(sessionId) ?? [])[0] ?? null;
    if (!next) await this.notifyEmptyRead(sessionId);
    return next;
  }

  async ack(sessionId: string, eventId: string): Promise<boolean> {
    if (this.failNextAck) {
      this.failNextAck = false;
      throw new Error("simulated crash before pending acknowledgement");
    }
    const queue = this.queues.get(sessionId) ?? [];
    if (queue[0]?.id !== eventId) return false;
    queue.shift();
    return true;
  }

  async listPendingSessionIds(): Promise<string[]> {
    const ids = [...this.queues.entries()]
      .filter(([, queue]) => queue.length > 0)
      .map(([sessionId]) => sessionId);
    return this.duplicateListedSessions ? [...ids, ...ids] : ids;
  }

  async clear(sessionId: string): Promise<void> {
    this.queues.delete(sessionId);
  }

  async count(sessionId: string): Promise<number> {
    return (this.queues.get(sessionId) ?? []).length;
  }
}

class InMemorySessionStore implements SessionStore {
  private sessions: Session[] = [];
  private nextId = 1;
  failBeforeAdapterOnce = false;
  failBeforeCompletionMarkerOnce = false;

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

  async list(tenantId: string, opts?: SessionStoreListOpts): Promise<PaginatedResult<Session>> {
    const limit = opts?.limit ?? 50;
    const filtered = this.sessions.filter((s) => s.tenantId === tenantId);
    return { data: filtered.slice(0, limit), hasMore: filtered.length > limit };
  }

  async updateStatus(id: string, status: SessionStatus): Promise<Session | null> {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return null;
    session.status = status;
    session.updatedAt = new Date();
    if (status === "running" && this.failBeforeAdapterOnce) {
      this.failBeforeAdapterOnce = false;
      throw new Error("simulated crash before adapter start");
    }
    if (status === "idle" && this.failBeforeCompletionMarkerOnce) {
      this.failBeforeCompletionMarkerOnce = false;
      throw new Error("simulated crash after durable output");
    }
    return session;
  }

  async setTitle(id: string, title: string): Promise<Session | null> {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return null;
    session.title = title;
    return session;
  }

  async terminate(id: string): Promise<Session | null> {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return null;
    session.status = "terminated";
    session.terminatedAt = new Date();
    return session;
  }
}

const testAgent: Agent = {
  id: "agent_1",
  tenantId: "tenant_1",
  name: "Test Agent",
  model: "claude-3",
  system: "You are helpful",
  runtime: "claude-code",
  // Opt out of the mandatory sandbox: this repro exercises the drain/abort flow
  // with no sandbox manager configured (issue #54 fail-loud path is not the SUT).
  sandbox: { enabled: false },
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeDeps(adapter: Adapter) {
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

async function enqueueUser(
  store: PendingEventStore,
  sessionId: string,
  text: string,
): Promise<void> {
  await store.enqueue(sessionId, {
    type: "user.message",
    data: { content: [{ type: "text", text }] },
    sessionThreadId: "sthr_primary",
  });
}

// ─── REPRO 3a: interrupt now unwedges a hung turn (the FIX) ──────────────────

/**
 * A realistic post-fix adapter: turn 1 hangs (its `prompt()` never settles,
 * modeled here as a run() that never emits its terminal event) UNTIL the router
 * aborts the turn — then it honors `input.signal` (Pi's native abort) and
 * completes. Turn 2 runs normally. Before the fix, the router never threaded the
 * per-turn signal into the adapter, so an interrupt could not reach a hung turn:
 * the `for await` in drainLoop only re-checks `aborted` on the NEXT event, which
 * never came, and `activeSessions` stayed locked forever.
 */
function hangUntilAbortedAdapter(): {
  adapter: Adapter;
  turn1Settled: () => "resolved" | "pending";
} {
  let turn = 0;
  let settled: "resolved" | "pending" = "pending";
  const adapter: Adapter = {
    async *run(input: AdapterInput): AsyncIterable<SessionEvent> {
      turn++;
      if (turn === 1) {
        // The hung turn: block until the router's signal aborts. A real adapter
        // wires input.signal to its runtime's native cancel, which settles the
        // run — here we simply await the signal, then return cleanly.
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted) return resolve();
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        settled = "resolved";
        return; // turn 1 settles once aborted — no terminal event needed
      }
      // Turn 2: a normal, quick reply that produces a new event.
      yield {
        id: `evt_turn${turn}`,
        timestamp: "2024-01-01T00:00:00.000Z",
        type: "agent.message",
        content: [{ type: "text", text: `Reply ${turn}` }],
      };
    },
  };
  return { adapter, turn1Settled: () => settled };
}

describe("REPRO 3a — interrupt unwedges a hung turn via the wired AbortSignal (issue #84, FIXED)", () => {
  it("interrupting a hung turn settles it, releases activeSessions, and lets the next turn drain", async () => {
    const { adapter, turn1Settled } = hangUntilAbortedAdapter();
    const { pendingEventStore, sessionStore, eventLogStore, router } = makeDeps(adapter);

    const session = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: "agent_1",
      agent: testAgent,
      workspaceId: "ws_test",
    });

    // Turn 1 arrives and wedges. Do NOT await — handleNewEvent blocks on the
    // hung drainLoop until we interrupt it.
    await enqueueUser(pendingEventStore, session.id, "hang please");
    const turn1 = router.handleNewEvent(session.id, testAgent);

    // Let turn 1 reach the adapter and wedge.
    await new Promise((r) => setTimeout(r, 20));
    expect(turn1Settled()).toBe("pending");

    // The user cancels: this must reach the hung turn (pre-fix it could not).
    router.interrupt(session.id);

    // Turn 1 settles and handleNewEvent returns — the session lock is released.
    await turn1;
    expect(turn1Settled()).toBe("resolved");

    // The SECOND handleNewEvent must now actually drain (activeSessions freed).
    await enqueueUser(pendingEventStore, session.id, "next question");
    await router.handleNewEvent(session.id, testAgent);

    // Turn 2 produced a new agent.message and the pending queue is drained.
    expect(await pendingEventStore.count(session.id)).toBe(0);
    const all = await eventLogStore.getEvents(session.id, { limit: 100 });
    const replies = all.data.filter((e) => e.type === "agent.message");
    expect(replies).toHaveLength(1);
    expect((replies[0].data as { content: { text: string }[] }).content[0].text).toBe(
      "Reply 2",
    );

    // Session ends idle (not stuck running).
    expect((await sessionStore.getById(session.id))!.status).toBe("idle");
  });
});

// ─── REPRO 3c: an arrival at the empty→unlock boundary is not stranded ──────

describe("REPRO 3c — drain handoff does not lose a wakeup", () => {
  it("drains a message accepted after the queue looked empty but before the active drain unlocked", async () => {
    let replies = 0;
    const adapter: Adapter = {
      async *run(): AsyncIterable<SessionEvent> {
        replies++;
        yield {
          id: `reply_${replies}`,
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text: `reply ${replies}` }],
        };
      },
    };
    const { pendingEventStore, sessionStore, eventLogStore, router } = makeDeps(adapter);
    const session = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: "agent_1",
      agent: testAgent,
      workspaceId: "ws_test",
    });

    await enqueueUser(pendingEventStore, session.id, "first");
    pendingEventStore.onEmptyRead = async () => {
      // This is the exact lost-wakeup window: dequeue has already decided the
      // queue is empty, but handleNewEvent still sees this Session as active.
      await enqueueUser(pendingEventStore, session.id, "arrived during handoff");
      await router.handleNewEvent(session.id, testAgent);
    };

    await router.handleNewEvent(session.id, testAgent);

    await vi.waitFor(async () => {
      expect(await pendingEventStore.count(session.id)).toBe(0);
    });
    expect(replies).toBe(2);
    const stored = await eventLogStore.getEvents(session.id, { limit: 100 });
    const userTexts = stored.data
      .filter((event) => event.type === "user.message")
      .map((event) =>
        (event.data as { content: Array<{ text: string }> }).content[0].text
      );
    expect(userTexts).toEqual(["first", "arrived during handoff"]);
  });
});

// ─── REPRO 3d: pending input survives promotion failure / process restart ────

describe("REPRO 3d — pending promotion is crash-recoverable", () => {
  it("retries after a crash that committed the user Event but happened before pending acknowledgement", async () => {
    const durableEvents = new DurableInMemoryEventLogStore();
    let failAfterCommit = true;
    const crashingEventStore: EventLogStore = {
      async append(sessionId, event) {
        const stored = await durableEvents.append(sessionId, event);
        if (failAfterCommit && event.type === "user.message") {
          failAfterCommit = false;
          throw new Error("simulated crash after Event commit");
        }
        return stored;
      },
      getEvents: (sessionId, opts) => durableEvents.getEvents(sessionId, opts),
    };
    const pendingEventStore = new InMemoryPendingEventStore();
    const sessionStore = new InMemorySessionStore();
    const eventStreamHub = new InProcessEventStreamHub();
    let replies = 0;
    const adapter: Adapter = {
      async *run(): AsyncIterable<SessionEvent> {
        replies++;
        yield {
          id: `reply_${replies}`,
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text: "recovered" }],
        };
      },
    };
    const makeRouter = () => new SessionRouter({
      eventLogStore: crashingEventStore,
      pendingEventStore,
      sessionStore,
      eventStreamHub,
      resolveAdapter: () => adapter,
    });
    const session = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: "agent_1",
      agent: testAgent,
      workspaceId: "ws_test",
    });
    await enqueueUser(pendingEventStore, session.id, "must survive");

    await expect(makeRouter().handleNewEvent(session.id, testAgent)).rejects.toThrow(
      "simulated crash after Event commit",
    );
    // A new router models a fresh process after the crash. The accepted input
    // must still be pending even though its canonical Event already committed.
    expect(await pendingEventStore.count(session.id)).toBe(1);

    const recovery = await makeRouter().recoverPendingEvents();
    await vi.waitFor(async () => {
      expect(await pendingEventStore.count(session.id)).toBe(0);
    });

    expect(replies).toBe(1);
    expect(recovery).toEqual({
      recovered: [session.id],
      discarded: [],
      failed: [],
    });
    const stored = await durableEvents.getEvents(session.id, { limit: 100 });
    expect(stored.data.filter((event) => event.type === "user.message")).toHaveLength(1);
    expect(stored.data.filter((event) => event.type === "agent.message")).toHaveLength(1);
  });

  it("deduplicates Session ids and clears pending input for missing or terminated Sessions", async () => {
    const adapter: Adapter = {
      async *run(): AsyncIterable<SessionEvent> {
        yield {
          id: "reply",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text: "ok" }],
        };
      },
    };
    const { pendingEventStore, sessionStore, router } = makeDeps(adapter);
    const valid = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: "agent_1",
      agent: testAgent,
      workspaceId: "ws_valid",
    });
    const terminated = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: "agent_1",
      agent: testAgent,
      workspaceId: "ws_terminated",
    });
    await sessionStore.terminate(terminated.id);
    await enqueueUser(pendingEventStore, valid.id, "valid");
    await enqueueUser(pendingEventStore, terminated.id, "discard terminated");
    await enqueueUser(pendingEventStore, "sess_missing", "discard missing");
    pendingEventStore.duplicateListedSessions = true;

    const recovery = await router.recoverPendingEvents();

    expect(recovery).toEqual({
      recovered: [valid.id],
      discarded: [terminated.id, "sess_missing"],
      failed: [],
    });
    await vi.waitFor(async () => {
      expect(await pendingEventStore.count(valid.id)).toBe(0);
    });
    expect(await pendingEventStore.count(terminated.id)).toBe(0);
    expect(await pendingEventStore.count("sess_missing")).toBe(0);
  });

  it("keeps input pending when the process dies before the Adapter starts, then executes it on restart", async () => {
    const eventLogStore = new DurableInMemoryEventLogStore();
    const pendingEventStore = new InMemoryPendingEventStore();
    const sessionStore = new InMemorySessionStore();
    const eventStreamHub = new InProcessEventStreamHub();
    let adapterRuns = 0;
    const adapter: Adapter = {
      async *run(): AsyncIterable<SessionEvent> {
        adapterRuns++;
        yield {
          id: "reply",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text: "recovered" }],
        };
      },
    };
    const makeRouter = () => new SessionRouter({
      eventLogStore,
      pendingEventStore,
      sessionStore,
      eventStreamHub,
      resolveAdapter: () => adapter,
    });
    const session = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: "agent_1",
      agent: testAgent,
      workspaceId: "ws_test",
    });
    await enqueueUser(pendingEventStore, session.id, "survive pre-adapter crash");
    sessionStore.failBeforeAdapterOnce = true;

    await expect(makeRouter().handleNewEvent(session.id, testAgent)).rejects.toThrow(
      "simulated crash before adapter start",
    );
    expect(await pendingEventStore.count(session.id)).toBe(1);

    await makeRouter().recoverPendingEvents();
    await vi.waitFor(async () => {
      expect(await pendingEventStore.count(session.id)).toBe(0);
    });
    expect(adapterRuns).toBe(1);
  });

  it("does not rerun or duplicate durable Events when completion committed before the ack crash", async () => {
    const eventLogStore = new DurableInMemoryEventLogStore();
    const pendingEventStore = new InMemoryPendingEventStore();
    const sessionStore = new InMemorySessionStore();
    const eventStreamHub = new InProcessEventStreamHub();
    let adapterRuns = 0;
    const adapter: Adapter = {
      async *run(): AsyncIterable<SessionEvent> {
        adapterRuns++;
        yield {
          id: "reply",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text: "complete once" }],
        };
      },
    };
    const makeRouter = () => new SessionRouter({
      eventLogStore,
      pendingEventStore,
      sessionStore,
      eventStreamHub,
      resolveAdapter: () => adapter,
    });
    const session = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: "agent_1",
      agent: testAgent,
      workspaceId: "ws_test",
    });
    await enqueueUser(pendingEventStore, session.id, "complete before ack");
    pendingEventStore.failNextAck = true;

    await expect(makeRouter().handleNewEvent(session.id, testAgent)).rejects.toThrow(
      "simulated crash before pending acknowledgement",
    );
    expect(await pendingEventStore.count(session.id)).toBe(1);
    const beforeRecovery = (await eventLogStore.getEvents(session.id, { limit: 100 })).data;
    expect(beforeRecovery.some((event) => event.type === "session.turn_completed")).toBe(true);

    await makeRouter().recoverPendingEvents();
    await vi.waitFor(async () => {
      expect(await pendingEventStore.count(session.id)).toBe(0);
    });
    const afterRecovery = (await eventLogStore.getEvents(session.id, { limit: 100 })).data;
    expect(adapterRuns).toBe(1);
    expect(afterRecovery).toEqual(beforeRecovery);
  });

  it("abandons a partial durable attempt without mixing output from a rerun", async () => {
    const eventLogStore = new DurableInMemoryEventLogStore();
    const pendingEventStore = new InMemoryPendingEventStore();
    const sessionStore = new InMemorySessionStore();
    const eventStreamHub = new InProcessEventStreamHub();
    let adapterRuns = 0;
    const adapter: Adapter = {
      async *run(): AsyncIterable<SessionEvent> {
        adapterRuns++;
        yield {
          id: `reply_${adapterRuns}`,
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text: "durable once" }],
        };
      },
    };
    const makeRouter = () => new SessionRouter({
      eventLogStore,
      pendingEventStore,
      sessionStore,
      eventStreamHub,
      resolveAdapter: () => adapter,
    });
    const session = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: "agent_1",
      agent: testAgent,
      workspaceId: "ws_test",
    });
    await enqueueUser(pendingEventStore, session.id, "retry partial completion");
    sessionStore.failBeforeCompletionMarkerOnce = true;

    await expect(makeRouter().handleNewEvent(session.id, testAgent)).rejects.toThrow(
      "simulated crash after durable output",
    );
    const partial = (await eventLogStore.getEvents(session.id, { limit: 100 })).data;
    expect(partial.filter((event) => event.type === "agent.message")).toHaveLength(1);
    expect(partial.some((event) => event.type === "session.turn_completed")).toBe(false);

    await makeRouter().recoverPendingEvents();
    await vi.waitFor(async () => {
      expect(await pendingEventStore.count(session.id)).toBe(0);
    });
    const recovered = (await eventLogStore.getEvents(session.id, { limit: 100 })).data;
    expect(adapterRuns).toBe(1);
    for (const type of [
      "user.message",
      "session.status_running",
      "agent.message",
      "session.status_idle",
      "session.turn_completed",
    ]) {
      expect(recovered.filter((event) => event.type === type), type).toHaveLength(1);
    }
    expect(recovered.filter((event) =>
      event.type === "session.error" &&
      (event.data as { error?: { code?: string } }).error?.code ===
        "recovery_partial_turn_aborted"
    )).toHaveLength(1);
  });

  it("schedules slow recovered Sessions without blocking startup and never starts two local drainers", async () => {
    let releaseAdapter!: () => void;
    let markStarted!: () => void;
    const adapterGate = new Promise<void>((resolve) => { releaseAdapter = resolve; });
    const adapterStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    let adapterRuns = 0;
    const adapter: Adapter = {
      async *run(): AsyncIterable<SessionEvent> {
        adapterRuns++;
        markStarted();
        await adapterGate;
        yield {
          id: "reply",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text: "slow done" }],
        };
      },
    };
    const { pendingEventStore, sessionStore, router } = makeDeps(adapter);
    const session = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: "agent_1",
      agent: testAgent,
      workspaceId: "ws_test",
    });
    await enqueueUser(pendingEventStore, session.id, "slow recovery");

    let recoveryReturned = false;
    const firstRecovery = router.recoverPendingEvents().then((summary) => {
      recoveryReturned = true;
      return summary;
    });
    await adapterStarted;
    await Promise.resolve();
    expect(recoveryReturned).toBe(true);

    // A repeated startup scan / trigger for the same retained queue must join
    // the already registered local drainer rather than start the Adapter again.
    await router.recoverPendingEvents();
    expect(adapterRuns).toBe(1);

    releaseAdapter();
    await firstRecovery;
    await vi.waitFor(async () => {
      expect(await pendingEventStore.count(session.id)).toBe(0);
    });
    expect(adapterRuns).toBe(1);
  });
});

describe("REPRO 3e — claimed turn ownership and attempt recovery", () => {
  it("allows only one Host to execute a claimed FIFO head", async () => {
    const stores = createMemoryStores();
    const hub = new InProcessEventStreamHub();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    let adapterRuns = 0;
    const adapter: Adapter = {
      async *run(): AsyncIterable<SessionEvent> {
        adapterRuns++;
        started();
        await gate;
        yield {
          id: "reply",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text: "once" }],
        };
      },
    };
    const session = await stores.sessionStore.create({
      tenantId: "tenant_1",
      agentId: testAgent.id,
      agent: testAgent,
      workspaceId: "ws_claim",
    });
    await enqueueUser(stores.pendingEventStore, session.id, "only once");
    const shared = {
      eventLogStore: stores.eventLogStore,
      pendingEventStore: stores.pendingEventStore,
      sessionStore: stores.sessionStore,
      resolveAdapter: () => adapter,
      pendingClaimLeaseMs: 1_000,
      pendingClaimRenewIntervalMs: 250,
      pendingClaimRetryMinMs: 5,
      pendingClaimRetryMaxMs: 10,
    };
    const hostA = new SessionRouter({
      ...shared,
      eventStreamHub: hub,
      pendingClaimOwnerId: "host_a",
    });
    const hostB = new SessionRouter({
      ...shared,
      eventStreamHub: hub,
      pendingClaimOwnerId: "host_b",
    });

    const first = hostA.handleNewEvent(session.id, testAgent);
    await didStart;
    await hostB.handleNewEvent(session.id, testAgent);
    expect(adapterRuns).toBe(1);
    expect(await hostB.waitForIdle(1)).toBe(false);

    release();
    await first;
    await vi.waitFor(async () => {
      expect(await stores.pendingEventStore.count(session.id)).toBe(0);
    });
    expect(adapterRuns).toBe(1);
    await expect(hostB.waitForIdle(100)).resolves.toBe(true);
  });

  it("retries a conflicting live claim after expiry without requiring a new message", async () => {
    const stores = createMemoryStores();
    const session = await stores.sessionStore.create({
      tenantId: "tenant_1",
      agentId: testAgent.id,
      agent: testAgent,
      workspaceId: "ws_claim_retry",
    });
    await stores.pendingEventStore.enqueue(session.id, {
      type: "user.message",
      data: { content: [{ type: "text", text: "retained" }] },
      sessionThreadId: "sthr_primary",
    });
    await stores.pendingEventStore.claim!(session.id, "old_host", 30);
    let adapterRuns = 0;
    const adapter: Adapter = {
      async *run(): AsyncIterable<SessionEvent> {
        adapterRuns++;
        yield {
          id: "reply",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text: "recovered after expiry" }],
        };
      },
    };
    const router = new SessionRouter({
      eventLogStore: stores.eventLogStore,
      pendingEventStore: stores.pendingEventStore,
      sessionStore: stores.sessionStore,
      eventStreamHub: new InProcessEventStreamHub(),
      resolveAdapter: () => adapter,
      pendingClaimOwnerId: "new_host",
      pendingClaimRetryMinMs: 5,
      pendingClaimRetryMaxMs: 10,
    });

    await router.handleNewEvent(session.id, testAgent);
    expect(adapterRuns).toBe(0);
    expect(await router.waitForIdle(1)).toBe(false);
    // An interrupt on this Host has no local active turn; it must not cancel
    // the recovery timer for the remote, live-but-doomed claim.
    router.interrupt(session.id);

    await vi.waitFor(async () => {
      expect(adapterRuns).toBe(1);
      expect(await stores.pendingEventStore.count(session.id)).toBe(0);
    });
    expect(await router.waitForIdle(100)).toBe(true);
  });

  it("aborts on heartbeat lease loss and retries with a fresh generation only after expiry", async () => {
    const stores = createMemoryStores();
    const session = await stores.sessionStore.create({
      tenantId: "tenant_1",
      agentId: testAgent.id,
      agent: testAgent,
      workspaceId: "ws_lease_loss",
    });
    await enqueueUser(stores.pendingEventStore, session.id, "lose lease once");
    const realRenew = stores.pendingEventStore.renewClaim.bind(stores.pendingEventStore);
    let rejectHeartbeat = true;
    stores.pendingEventStore.renewClaim = async (...args) =>
      rejectHeartbeat ? false : realRenew(...args);
    const attemptTurnIds: string[] = [];
    let adapterRuns = 0;
    let firstStarted!: () => void;
    const firstDidStart = new Promise<void>((resolve) => { firstStarted = resolve; });
    const adapter: Adapter = {
      async *run(input: AdapterInput): AsyncIterable<SessionEvent> {
        adapterRuns++;
        attemptTurnIds.push(input.turnId);
        if (adapterRuns === 1) {
          firstStarted();
          await new Promise<void>((resolve) => {
            if (input.signal?.aborted) resolve();
            else input.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return;
        }
        yield {
          id: "reply",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text: "fresh attempt" }],
        };
      },
    };
    const router = new SessionRouter({
      eventLogStore: stores.eventLogStore,
      pendingEventStore: stores.pendingEventStore,
      sessionStore: stores.sessionStore,
      eventStreamHub: new InProcessEventStreamHub(),
      resolveAdapter: () => adapter,
      pendingClaimOwnerId: "host_retry",
      pendingClaimLeaseMs: 30,
      pendingClaimRenewIntervalMs: 5,
      pendingClaimRetryMinMs: 5,
      pendingClaimRetryMaxMs: 10,
    });

    const firstDrain = router.handleNewEvent(session.id, testAgent);
    await firstDidStart;
    await firstDrain;
    expect(await stores.pendingEventStore.count(session.id)).toBe(1);
    expect((await stores.eventLogStore.getEvents(session.id, { limit: 100 })).data
      .filter((event) => event.type === "session.turn_completed")).toHaveLength(0);

    rejectHeartbeat = false;
    await vi.waitFor(async () => {
      expect(await stores.pendingEventStore.count(session.id)).toBe(0);
    });
    expect(adapterRuns).toBe(2);
    expect(attemptTurnIds).toEqual(["turn_1_a1", "turn_1_a2"]);
    expect((await stores.eventLogStore.getEvents(session.id, { limit: 100 })).data
      .filter((event) => event.type === "session.turn_completed")).toHaveLength(1);
  });

  it("does not revive a Session terminated between claim and running status", async () => {
    const stores = createMemoryStores();
    const session = await stores.sessionStore.create({
      tenantId: "tenant_1",
      agentId: testAgent.id,
      agent: testAgent,
      workspaceId: "ws_terminate_race",
    });
    await enqueueUser(stores.pendingEventStore, session.id, "must not run");
    const realUpdate = stores.sessionStore.updateStatusIfClaimed.bind(stores.sessionStore);
    let terminateBeforeRunning = true;
    stores.sessionStore.updateStatusIfClaimed = async (id, status, fence) => {
      if (status === "running" && terminateBeforeRunning) {
        terminateBeforeRunning = false;
        await stores.sessionStore.terminate(id);
      }
      return realUpdate(id, status, fence);
    };
    let adapterRuns = 0;
    const router = new SessionRouter({
      eventLogStore: stores.eventLogStore,
      pendingEventStore: stores.pendingEventStore,
      sessionStore: stores.sessionStore,
      eventStreamHub: new InProcessEventStreamHub(),
      resolveAdapter: () => ({
        async *run(): AsyncIterable<SessionEvent> {
          adapterRuns++;
        },
      }),
    });

    await router.handleNewEvent(session.id, testAgent);
    expect(adapterRuns).toBe(0);
    expect((await stores.sessionStore.getById(session.id))?.status).toBe("terminated");
    expect(await stores.pendingEventStore.count(session.id)).toBe(0);
  });

  it("a late stale generation cannot clear or idle a newer Host's active turn", async () => {
    const stores = createMemoryStores();
    const turns = new InMemoryTurnStreamStore();
    const session = await stores.sessionStore.create({
      tenantId: "tenant_1",
      agentId: testAgent.id,
      agent: testAgent,
      workspaceId: "ws_late_cleanup",
    });
    await enqueueUser(stores.pendingEventStore, session.id, "late cleanup");

    const realRenew = stores.pendingEventStore.renewClaim.bind(stores.pendingEventStore);
    let gen1Renewals = 0;
    let markLateRenew!: () => void;
    const lateRenewStarted = new Promise<void>((resolve) => { markLateRenew = resolve; });
    let releaseLateRenew!: () => void;
    const lateRenewGate = new Promise<void>((resolve) => { releaseLateRenew = resolve; });
    stores.pendingEventStore.renewClaim = async (...args) => {
      const claim = args[2];
      if (claim.generation !== 1) return realRenew(...args);
      gen1Renewals++;
      if (gen1Renewals === 1) return realRenew(...args); // pre-checkpoint fence
      if (gen1Renewals === 2) {
        markLateRenew();
        await lateRenewGate;
      }
      return false;
    };

    let markGen2Running!: () => void;
    const gen2Running = new Promise<void>((resolve) => { markGen2Running = resolve; });
    let releaseGen2!: () => void;
    const gen2Gate = new Promise<void>((resolve) => { releaseGen2 = resolve; });
    const adapter: Adapter = {
      async *run(input: AdapterInput): AsyncIterable<SessionEvent> {
        yield {
          id: `start_${input.turnId}`,
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message_stream_start",
        };
        yield {
          id: `chunk_${input.turnId}`,
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message_chunk",
          text: input.turnId.endsWith("a1") ? "old" : "new",
        };
        if (input.turnId.endsWith("a1")) {
          yield {
            id: `end_${input.turnId}`,
            timestamp: "2024-01-01T00:00:00.000Z",
            type: "agent.message_stream_end",
          };
          return;
        }
        markGen2Running();
        await gen2Gate;
        yield {
          id: `end_${input.turnId}`,
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message_stream_end",
        };
        yield {
          id: "new_reply",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text: "new" }],
        };
      },
    };
    const shared = {
      eventLogStore: stores.eventLogStore,
      pendingEventStore: stores.pendingEventStore,
      sessionStore: stores.sessionStore,
      turnStreamStore: turns,
      resolveAdapter: () => adapter,
      pendingClaimRetryMinMs: 5,
      pendingClaimRetryMaxMs: 10,
    };
    const staleHost = new SessionRouter({
      ...shared,
      eventStreamHub: new InProcessEventStreamHub(),
      pendingClaimOwnerId: "stale_host",
      pendingClaimLeaseMs: 60,
      pendingClaimRenewIntervalMs: 50,
    });
    const newHost = new SessionRouter({
      ...shared,
      eventStreamHub: new InProcessEventStreamHub(),
      pendingClaimOwnerId: "new_host",
      pendingClaimLeaseMs: 1_000,
      pendingClaimRenewIntervalMs: 250,
    });

    const staleDrain = staleHost.handleNewEvent(session.id, testAgent);
    await lateRenewStarted;
    await new Promise((resolve) => setTimeout(resolve, 80));
    const newDrain = newHost.handleNewEvent(session.id, testAgent);
    await gen2Running;

    expect(await turns.getActiveTurn(session.id)).toEqual({
      turnId: "turn_1_a2",
      status: "running",
    });
    expect(await turns.deltaCount("turn_1_a2")).toBeGreaterThan(0);

    releaseLateRenew();
    await staleDrain;
    expect(await turns.getActiveTurn(session.id)).toEqual({
      turnId: "turn_1_a2",
      status: "running",
    });
    expect(await turns.deltaCount("turn_1_a2")).toBeGreaterThan(0);

    releaseGen2();
    await newDrain;
    await vi.waitFor(async () => {
      expect(await stores.pendingEventStore.count(session.id)).toBe(0);
    });
  });

  it("repairs a durable tool_use without rerunning that attempt, then supplies a valid pair to the next turn", async () => {
    const stores = createMemoryStores();
    const session = await stores.sessionStore.create({
      tenantId: "tenant_1",
      agentId: testAgent.id,
      agent: testAgent,
      workspaceId: "ws_partial_tool",
    });
    const pending = await stores.pendingEventStore.enqueue(session.id, {
      type: "user.message",
      data: { content: [{ type: "text", text: "run tool" }] },
      sessionThreadId: "sthr_primary",
    });
    const firstClaim = await stores.pendingEventStore.claim!(session.id, "dead_host", 60_000);
    const firstFence = {
      eventId: pending.id,
      ownerId: firstClaim!.ownerId,
      generation: firstClaim!.generation,
    };
    await stores.eventLogStore.append(session.id, {
      type: "user.message",
      data: pending.data,
      sessionThreadId: "sthr_primary",
      idempotencyKey: `pending:${pending.id}`,
      pendingFence: firstFence,
    });
    await stores.eventLogStore.append(session.id, {
      type: "session.status_running",
      data: {},
      sessionThreadId: "sthr_primary",
      idempotencyKey: `pending:${pending.id}:status_running`,
      pendingFence: firstFence,
    });
    await stores.eventLogStore.append(session.id, {
      type: "agent.tool_use",
      data: {
        id: "tool_use_event",
        timestamp: "2024-01-01T00:00:00.000Z",
        type: "agent.tool_use",
        toolUseId: "call_crashed",
        name: "bash",
        input: { command: "echo side-effect" },
        turnId: "turn_1_a1",
      },
      sessionThreadId: "sthr_primary",
      idempotencyKey: `pending:${pending.id}:event:0`,
      pendingFence: firstFence,
    });
    await stores.pendingEventStore.releaseClaim!(session.id, pending.id, firstClaim!);

    let adapterRuns = 0;
    let nextHistory: SessionEvent[] = [];
    const adapter: Adapter = {
      async *run(input: AdapterInput): AsyncIterable<SessionEvent> {
        adapterRuns++;
        nextHistory = input.history;
        yield {
          id: "next_reply",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text: "history accepted" }],
        };
      },
    };
    const router = new SessionRouter({
      eventLogStore: stores.eventLogStore,
      pendingEventStore: stores.pendingEventStore,
      sessionStore: stores.sessionStore,
      eventStreamHub: new InProcessEventStreamHub(),
      resolveAdapter: () => adapter,
      pendingClaimOwnerId: "recovery_host",
    });

    await router.handleNewEvent(session.id, testAgent);
    expect(adapterRuns).toBe(0);
    const repaired = (await stores.eventLogStore.getEvents(session.id, { limit: 100 })).data;
    const result = repaired.find((event) =>
      event.type === "agent.tool_result" &&
      (event.data as { toolUseId?: string }).toolUseId === "call_crashed"
    );
    expect(result?.data).toMatchObject({ toolUseId: "call_crashed", isError: true });
    expect(repaired.filter((event) => event.type === "agent.tool_use")).toHaveLength(1);

    await enqueueUser(stores.pendingEventStore, session.id, "continue safely");
    await router.handleNewEvent(session.id, testAgent);
    expect(adapterRuns).toBe(1);
    const pair = nextHistory.filter((event) =>
      (event.type === "agent.tool_use" || event.type === "agent.tool_result") &&
      (event as unknown as { toolUseId?: string }).toolUseId === "call_crashed"
    );
    expect(pair.map((event) => event.type)).toEqual([
      "agent.tool_use",
      "agent.tool_result",
    ]);
  });

  it("uses a new generation turnId and reclaims stale deltas before a safe retry", async () => {
    const stores = createMemoryStores();
    const turns = new InMemoryTurnStreamStore();
    const session = await stores.sessionStore.create({
      tenantId: "tenant_1",
      agentId: testAgent.id,
      agent: testAgent,
      workspaceId: "ws_delta_retry",
    });
    const pending = await stores.pendingEventStore.enqueue(session.id, {
      type: "user.message",
      data: { content: [{ type: "text", text: "retry" }] },
      sessionThreadId: "sthr_primary",
    });
    const firstClaim = await stores.pendingEventStore.claim!(session.id, "dead_host", 60_000);
    const firstFence = {
      eventId: pending.id,
      ownerId: firstClaim!.ownerId,
      generation: firstClaim!.generation,
    };
    const promoted = await stores.eventLogStore.append(session.id, {
      type: pending.type,
      data: pending.data,
      sessionThreadId: pending.sessionThreadId,
      idempotencyKey: `pending:${pending.id}`,
      pendingFence: firstFence,
    });
    await stores.eventLogStore.append(session.id, {
      type: "session.status_running",
      data: {},
      sessionThreadId: "sthr_primary",
      idempotencyKey: `pending:${pending.id}:status_running`,
      pendingFence: firstFence,
    });
    const oldTurnId = `turn_${promoted.seq}_a1`;
    await turns.setActiveTurn(session.id, { turnId: oldTurnId, status: "running" });
    await turns.appendDelta({
      turnId: oldTurnId,
      blockIndex: 0,
      type: "agent.message_chunk",
      data: { text: "Hel" },
    });
    await stores.pendingEventStore.releaseClaim!(session.id, pending.id, firstClaim!);

    let retryTurnId = "";
    const adapter: Adapter = {
      async *run(input: AdapterInput): AsyncIterable<SessionEvent> {
        retryTurnId = input.turnId;
        yield {
          id: "reply",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text: "Hello" }],
        };
      },
    };
    const router = new SessionRouter({
      eventLogStore: stores.eventLogStore,
      pendingEventStore: stores.pendingEventStore,
      sessionStore: stores.sessionStore,
      eventStreamHub: new InProcessEventStreamHub(),
      turnStreamStore: turns,
      resolveAdapter: () => adapter,
      pendingClaimOwnerId: "new_host",
    });

    await router.handleNewEvent(session.id, testAgent);
    expect(retryTurnId).toBe(`turn_${promoted.seq}_a2`);
    expect(retryTurnId).not.toBe(oldTurnId);
    expect(await turns.deltaCount(oldTurnId)).toBe(0);
    const output = (await stores.eventLogStore.getEvents(session.id, { limit: 100 })).data
      .find((event) => event.type === "agent.message");
    expect(output?.data).toMatchObject({ turnId: retryTurnId });
  });
});

// ─── REPRO 3b: drainLoop history is no longer truncated past 50 events ────────

/**
 * Before the fix (issue #82) drainLoop read history with a bare
 * `getEvents(sessionId)`, which the store serves at its default `limit: 50` /
 * `seq ASC` — so a session with >50 events fed the adapter only the OLDEST 50,
 * dropping recent turns (and potentially splitting a tool_use from its
 * tool_result). The router now paginates on `hasMore`, so the adapter receives
 * the complete, gap-free history. This adapter captures what history it saw.
 */
function historyCapturingAdapter(): {
  adapter: Adapter;
  seenHistory: () => SessionEvent[];
} {
  let captured: SessionEvent[] = [];
  const adapter: Adapter = {
    async *run(input: AdapterInput): AsyncIterable<SessionEvent> {
      captured = input.history;
      yield {
        id: "evt_reply",
        timestamp: "2024-01-01T00:00:00.000Z",
        type: "agent.message",
        content: [{ type: "text", text: "ok" }],
      };
    },
  };
  return { adapter, seenHistory: () => captured };
}

describe("REPRO 3b — drainLoop history is NOT truncated past 50 events (issue #82, FIXED)", () => {
  it("feeds the adapter the full, gap-free history rather than the oldest 50", async () => {
    const { adapter, seenHistory } = historyCapturingAdapter();
    const { pendingEventStore, sessionStore, eventLogStore, router } = makeDeps(adapter);

    const session = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: "agent_1",
      agent: testAgent,
      workspaceId: "ws_test",
    });

    // Seed 60 prior events — more than the store's default page of 50.
    for (let i = 0; i < 60; i++) {
      await eventLogStore.append(session.id, {
        type: "agent.message",
        data: { content: [{ type: "text", text: `old ${i}` }] },
        sessionThreadId: "sthr_primary",
      });
    }

    await enqueueUser(pendingEventStore, session.id, "new message");
    await router.handleNewEvent(session.id, testAgent);

    // The adapter saw the FULL history (all 60 prior events), not a truncated
    // prefix. Both the very first and the very last seeded messages are present,
    // proving there is no gap at either end.
    const history = seenHistory();
    expect(history.length).toBeGreaterThan(50);
    const texts = history
      .map((e) => (e as unknown as { content?: { text: string }[] }).content?.[0]?.text)
      .filter((t): t is string => typeof t === "string");
    expect(texts).toContain("old 0");
    expect(texts).toContain("old 59");

    // Sanity: there really are >50 prior events, so this is the pagination fix,
    // not a small-count artifact.
    const all = await eventLogStore.getEvents(session.id, { limit: 1000 });
    expect(all.data.length).toBeGreaterThan(50);
  });

  it("does not split a tool_use from its tool_result across the old 50-event boundary", async () => {
    // The concrete failure mode #82 warned about: a tool_use at seq ≤50 whose
    // tool_result lives at seq >50. The oldest-50 truncation would feed the
    // adapter the tool_use but DROP its tool_result, producing a dangling
    // tool_use the model API rejects. With full pagination both halves survive.
    const { adapter, seenHistory } = historyCapturingAdapter();
    const { pendingEventStore, sessionStore, eventLogStore, router } = makeDeps(adapter);

    const session = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: "agent_1",
      agent: testAgent,
      workspaceId: "ws_test",
    });

    // Seed 48 filler events, then a tool_use (seq 49) + its tool_result (seq 50),
    // then 20 more filler events — so the pair straddles the old 50 cutoff and
    // the tool_result sits beyond it.
    for (let i = 0; i < 48; i++) {
      await eventLogStore.append(session.id, {
        type: "agent.message",
        data: { content: [{ type: "text", text: `filler ${i}` }] },
        sessionThreadId: "sthr_primary",
      });
    }
    await eventLogStore.append(session.id, {
      type: "agent.tool_use",
      data: { toolUseId: "call_straddle", name: "bash", input: { command: "echo hi" } },
      sessionThreadId: "sthr_primary",
    });
    await eventLogStore.append(session.id, {
      type: "agent.tool_result",
      data: { toolUseId: "call_straddle", content: [{ type: "text", text: "hi" }] },
      sessionThreadId: "sthr_primary",
    });
    for (let i = 0; i < 20; i++) {
      await eventLogStore.append(session.id, {
        type: "agent.message",
        data: { content: [{ type: "text", text: `tail ${i}` }] },
        sessionThreadId: "sthr_primary",
      });
    }

    await enqueueUser(pendingEventStore, session.id, "continue");
    await router.handleNewEvent(session.id, testAgent);

    // Both halves of the pair reached the adapter — no dangling tool_use.
    const history = seenHistory();
    const toolUse = history.find(
      (e) => e.type === "agent.tool_use" &&
        (e as unknown as { toolUseId?: string }).toolUseId === "call_straddle",
    );
    const toolResult = history.find(
      (e) => e.type === "agent.tool_result" &&
        (e as unknown as { toolUseId?: string }).toolUseId === "call_straddle",
    );
    expect(toolUse).toBeDefined();
    expect(toolResult).toBeDefined();
  });
});
