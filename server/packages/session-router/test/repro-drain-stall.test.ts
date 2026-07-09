import { describe, it, expect } from "vitest";
import { SessionRouter } from "../src/session-router.js";
import { InProcessEventStreamHub } from "@oma-server/event-log";
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
    return queue.shift() ?? null;
  }

  async peek(sessionId: string): Promise<PendingEvent | null> {
    return (this.queues.get(sessionId) ?? [])[0] ?? null;
  }

  async count(sessionId: string): Promise<number> {
    return (this.queues.get(sessionId) ?? []).length;
  }
}

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
