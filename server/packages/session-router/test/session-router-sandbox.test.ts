import { describe, it, expect, vi } from "vitest";
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
import type { SandboxOrchestrator, SandboxRef } from "@oma-server/sandbox";

// ─── In-memory EventLogStore ────────────────────────────────────────────────

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

// ─── Mock SandboxOrchestrator ───────────────────────────────────────────────

function createMockSandboxOrchestrator(events: SessionEvent[]): SandboxOrchestrator & {
  createForSession: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  runAdapterTurn: ReturnType<typeof vi.fn>;
} {
  const ref: SandboxRef = {
    sandboxId: "sbx_test_1",
    sessionId: "sess_1",
    status: "running",
  };

  return {
    createForSession: vi.fn().mockResolvedValue(ref),
    resume: vi.fn().mockResolvedValue(ref),
    pause: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
    runAdapterTurn: vi.fn().mockImplementation(
      async function* (_sessionId: string, _input: AdapterInput) {
        for (const event of events) {
          yield event;
        }
      },
    ),
  };
}

// ─── Test helpers ────────────────────────────────────────────────────────────

const testAgentSandboxed: Agent = {
  id: "agent_1",
  tenantId: "tenant_1",
  name: "Test Agent (Sandboxed)",
  model: "claude-3",
  system: "You are helpful",
  runtime: "claude-code",
  sandbox: { enabled: true, image: "ubuntu:22.04" },
  createdAt: new Date(),
  updatedAt: new Date(),
};

const testAgentNoSandbox: Agent = {
  id: "agent_2",
  tenantId: "tenant_1",
  name: "Test Agent (No Sandbox)",
  model: "claude-3",
  system: "You are helpful",
  runtime: "claude-code",
  createdAt: new Date(),
  updatedAt: new Date(),
};

function createTestDeps(opts: {
  adapter?: Adapter;
  sandboxOrchestrator?: SandboxOrchestrator;
}) {
  const eventLogStore = new InMemoryEventLogStore();
  const pendingEventStore = new InMemoryPendingEventStore();
  const sessionStore = new InMemorySessionStore();
  const eventStreamHub = new InProcessEventStreamHub();

  const defaultAdapter: Adapter = {
    async *run(_input: AdapterInput): AsyncIterable<SessionEvent> {
      yield {
        id: "evt_direct",
        timestamp: "2024-01-01T00:00:00.000Z",
        type: "agent.message",
        content: [{ type: "text", text: "Direct adapter reply" }],
      };
    },
  };

  const router = new SessionRouter({
    eventLogStore,
    pendingEventStore,
    sessionStore,
    eventStreamHub,
    resolveAdapter: () => opts.adapter ?? defaultAdapter,
    sandboxOrchestrator: opts.sandboxOrchestrator,
  });

  return { eventLogStore, pendingEventStore, sessionStore, eventStreamHub, router };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("SessionRouter - sandbox orchestration", () => {
  describe("sandboxed session creates sandbox on first turn", () => {
    it("calls createForSession on the first turn", async () => {
      const sandboxEvents: SessionEvent[] = [
        {
          id: "evt_sbx_1",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text: "Sandbox reply" }],
        },
      ];

      const orchestrator = createMockSandboxOrchestrator(sandboxEvents);
      const { pendingEventStore, sessionStore, router } = createTestDeps({
        sandboxOrchestrator: orchestrator,
      });

      const session = await sessionStore.create({
        tenantId: "tenant_1",
        agentId: "agent_1",
        agent: testAgentSandboxed,
      });

      await pendingEventStore.enqueue(session.id, {
        type: "user.message",
        data: { content: [{ type: "text", text: "Hello" }] },
        sessionThreadId: "sthr_primary",
      });

      await router.handleNewEvent(session.id, testAgentSandboxed);

      expect(orchestrator.createForSession).toHaveBeenCalledTimes(1);
      expect(orchestrator.createForSession).toHaveBeenCalledWith(session.id, {
        image: "ubuntu:22.04",
      });
      expect(orchestrator.resume).not.toHaveBeenCalled();
    });
  });

  describe("sandboxed session resumes on subsequent turns", () => {
    it("calls resume instead of createForSession on the second turn", async () => {
      const sandboxEvents: SessionEvent[] = [
        {
          id: "evt_sbx_1",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text: "Sandbox reply" }],
        },
      ];

      const orchestrator = createMockSandboxOrchestrator(sandboxEvents);
      const { pendingEventStore, sessionStore, router } = createTestDeps({
        sandboxOrchestrator: orchestrator,
      });

      const session = await sessionStore.create({
        tenantId: "tenant_1",
        agentId: "agent_1",
        agent: testAgentSandboxed,
      });

      // Enqueue two messages to process in one drain loop
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

      await router.handleNewEvent(session.id, testAgentSandboxed);

      // First turn: create, second turn: resume
      expect(orchestrator.createForSession).toHaveBeenCalledTimes(1);
      expect(orchestrator.resume).toHaveBeenCalledTimes(1);
      expect(orchestrator.resume).toHaveBeenCalledWith(session.id);
    });
  });

  describe("sandbox is paused after each turn", () => {
    it("calls pause after each turn execution", async () => {
      const sandboxEvents: SessionEvent[] = [
        {
          id: "evt_sbx_1",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text: "Sandbox reply" }],
        },
      ];

      const orchestrator = createMockSandboxOrchestrator(sandboxEvents);
      const { pendingEventStore, sessionStore, router } = createTestDeps({
        sandboxOrchestrator: orchestrator,
      });

      const session = await sessionStore.create({
        tenantId: "tenant_1",
        agentId: "agent_1",
        agent: testAgentSandboxed,
      });

      // Two turns
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

      await router.handleNewEvent(session.id, testAgentSandboxed);

      // Pause should be called once per turn
      expect(orchestrator.pause).toHaveBeenCalledTimes(2);
      expect(orchestrator.pause).toHaveBeenCalledWith(session.id);
    });
  });

  describe("sandbox is killed when session drain loop ends", () => {
    it("calls kill after the drain loop completes", async () => {
      const sandboxEvents: SessionEvent[] = [
        {
          id: "evt_sbx_1",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text: "Reply" }],
        },
      ];

      const orchestrator = createMockSandboxOrchestrator(sandboxEvents);
      const { pendingEventStore, sessionStore, router } = createTestDeps({
        sandboxOrchestrator: orchestrator,
      });

      const session = await sessionStore.create({
        tenantId: "tenant_1",
        agentId: "agent_1",
        agent: testAgentSandboxed,
      });

      await pendingEventStore.enqueue(session.id, {
        type: "user.message",
        data: { content: [{ type: "text", text: "Hello" }] },
        sessionThreadId: "sthr_primary",
      });

      await router.handleNewEvent(session.id, testAgentSandboxed);

      expect(orchestrator.kill).toHaveBeenCalledTimes(1);
      expect(orchestrator.kill).toHaveBeenCalledWith(session.id);
    });
  });

  describe("sandbox runAdapterTurn produces events correctly", () => {
    it("events from sandbox orchestrator are persisted in the event log", async () => {
      const sandboxEvents: SessionEvent[] = [
        {
          id: "evt_sbx_1",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text: "From sandbox" }],
        },
      ];

      const orchestrator = createMockSandboxOrchestrator(sandboxEvents);
      const { eventLogStore, pendingEventStore, sessionStore, router } = createTestDeps({
        sandboxOrchestrator: orchestrator,
      });

      const session = await sessionStore.create({
        tenantId: "tenant_1",
        agentId: "agent_1",
        agent: testAgentSandboxed,
      });

      await pendingEventStore.enqueue(session.id, {
        type: "user.message",
        data: { content: [{ type: "text", text: "Hello" }] },
        sessionThreadId: "sthr_primary",
      });

      await router.handleNewEvent(session.id, testAgentSandboxed);

      expect(orchestrator.runAdapterTurn).toHaveBeenCalledTimes(1);

      const allEvents = await eventLogStore.getEvents(session.id, { limit: 100 });
      const types = allEvents.data.map((e) => e.type);
      expect(types).toContain("agent.message");
    });
  });

  describe("non-sandboxed sessions skip sandbox entirely", () => {
    it("does not call any sandbox orchestrator methods for non-sandboxed agent", async () => {
      const sandboxEvents: SessionEvent[] = [];
      const orchestrator = createMockSandboxOrchestrator(sandboxEvents);
      const { pendingEventStore, sessionStore, eventLogStore, router } = createTestDeps({
        sandboxOrchestrator: orchestrator,
      });

      const session = await sessionStore.create({
        tenantId: "tenant_1",
        agentId: "agent_2",
        agent: testAgentNoSandbox,
      });

      await pendingEventStore.enqueue(session.id, {
        type: "user.message",
        data: { content: [{ type: "text", text: "Hello" }] },
        sessionThreadId: "sthr_primary",
      });

      await router.handleNewEvent(session.id, testAgentNoSandbox);

      // No sandbox methods called
      expect(orchestrator.createForSession).not.toHaveBeenCalled();
      expect(orchestrator.resume).not.toHaveBeenCalled();
      expect(orchestrator.pause).not.toHaveBeenCalled();
      expect(orchestrator.kill).not.toHaveBeenCalled();
      expect(orchestrator.runAdapterTurn).not.toHaveBeenCalled();

      // Direct adapter was used instead
      const allEvents = await eventLogStore.getEvents(session.id, { limit: 100 });
      const types = allEvents.data.map((e) => e.type);
      expect(types).toContain("agent.message");
    });

    it("does not use sandbox when orchestrator is not provided", async () => {
      const { pendingEventStore, sessionStore, eventLogStore, router } = createTestDeps({});

      const session = await sessionStore.create({
        tenantId: "tenant_1",
        agentId: "agent_1",
        agent: testAgentSandboxed,
      });

      await pendingEventStore.enqueue(session.id, {
        type: "user.message",
        data: { content: [{ type: "text", text: "Hello" }] },
        sessionThreadId: "sthr_primary",
      });

      // Even with sandboxed agent, no orchestrator means direct adapter
      await router.handleNewEvent(session.id, testAgentSandboxed);

      const allEvents = await eventLogStore.getEvents(session.id, { limit: 100 });
      const types = allEvents.data.map((e) => e.type);
      expect(types).toContain("agent.message");
    });
  });
});
