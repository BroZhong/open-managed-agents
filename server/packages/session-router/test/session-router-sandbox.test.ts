import { describe, it, expect } from "vitest";
import { SessionRouter } from "../src/session-router.js";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import {
  FakeSandboxClient,
  SandboxToolExecutorFactory,
} from "@oma-server/sandbox";
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
  Artifact,
  ArtifactContent,
  ArtifactPutInput,
  ArtifactStore,
} from "@oma-server/store";
import type {
  Adapter,
  AdapterInput,
  SessionEvent,
} from "@open-managed-agents/adapter-core";

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

// ─── In-memory ArtifactStore (stand-in S3 Workspace) ────────────────────────

class InMemoryArtifactStore implements ArtifactStore {
  private readonly objects = new Map<string, Uint8Array>();
  private key(t: string, w: string, p: string) {
    return `${t}/${w}/${p}`;
  }
  seed(t: string, w: string, p: string, content: string) {
    this.objects.set(this.key(t, w, p), new TextEncoder().encode(content));
  }
  async list(t: string, w: string, prefix = ""): Promise<Artifact[]> {
    const wsPrefix = `${t}/${w}/`;
    const out: Artifact[] = [];
    for (const [k, v] of this.objects) {
      if (!k.startsWith(wsPrefix)) continue;
      const rel = k.slice(wsPrefix.length);
      if (prefix && !rel.startsWith(prefix)) continue;
      out.push({ path: rel, size: v.byteLength });
    }
    return out;
  }
  async get(t: string, w: string, p: string): Promise<ArtifactContent | null> {
    const body = this.objects.get(this.key(t, w, p));
    return body ? { path: p, body } : null;
  }
  async put(input: ArtifactPutInput): Promise<Artifact> {
    const body =
      typeof input.body === "string"
        ? new TextEncoder().encode(input.body)
        : input.body;
    this.objects.set(this.key(input.tenantId, input.workspaceId, input.path), body);
    return { path: input.path, size: body.byteLength };
  }
  async delete(t: string, w: string, p: string): Promise<boolean> {
    return this.objects.delete(this.key(t, w, p));
  }
}

// ─── Adapters ────────────────────────────────────────────────────────────────

/** Pure-chat adapter: never touches input.toolExecutor. */
const chatAdapter: Adapter = {
  async *run(_input: AdapterInput): AsyncIterable<SessionEvent> {
    yield {
      id: "evt_chat",
      timestamp: "2024-01-01T00:00:00.000Z",
      type: "agent.message",
      content: [{ type: "text", text: "just chatting" }],
    };
  },
};

/**
 * Tool-using adapter: reads a workspace file through the injected executor and
 * echoes it back, proving a tool call runs against the hydrated sandbox.
 */
function toolReadingAdapter(path: string): Adapter {
  return {
    async *run(input: AdapterInput): AsyncIterable<SessionEvent> {
      const executor = input.toolExecutor;
      let body = "<no-executor>";
      if (executor) {
        body = await executor.readFile(path);
      }
      yield {
        id: "evt_tool",
        timestamp: "2024-01-01T00:00:00.000Z",
        type: "agent.message",
        content: [{ type: "text", text: body }],
      };
    },
  };
}

/**
 * Tool-using adapter that WRITES a file through the injected executor, so the
 * subsequent Host sync produces a real change. The adapter itself emits only a
 * plain tool-result message — never a workspace/artifact event.
 */
function toolWritingAdapter(path: string, content: string): Adapter {
  return {
    async *run(input: AdapterInput): AsyncIterable<SessionEvent> {
      const executor = input.toolExecutor;
      if (executor) {
        await executor.writeFile(path, content);
      }
      yield {
        id: "evt_tool_write",
        timestamp: "2024-01-01T00:00:00.000Z",
        type: "agent.message",
        content: [{ type: "text", text: "wrote it" }],
      };
    },
  };
}

// ─── Test fixtures ────────────────────────────────────────────────────────────

const sandboxedAgent: Agent = {
  id: "agent_sbx",
  tenantId: "tenant_1",
  name: "Sandboxed",
  model: "claude-3",
  system: "helpful",
  runtime: "pi-agent",
  sandbox: { enabled: true, image: "ubuntu:22.04" },
  createdAt: new Date(),
  updatedAt: new Date(),
};

const plainAgent: Agent = {
  id: "agent_plain",
  tenantId: "tenant_1",
  name: "Plain",
  model: "claude-3",
  system: "helpful",
  runtime: "pi-agent",
  createdAt: new Date(),
  updatedAt: new Date(),
};

function createDeps(opts: {
  adapter: Adapter;
  sandboxClient?: FakeSandboxClient;
  artifactStore?: InMemoryArtifactStore;
  withFactory?: boolean;
}) {
  const eventLogStore = new InMemoryEventLogStore();
  const pendingEventStore = new InMemoryPendingEventStore();
  const sessionStore = new InMemorySessionStore();
  const eventStreamHub = new InProcessEventStreamHub();
  const sandboxClient = opts.sandboxClient ?? new FakeSandboxClient();
  const artifactStore = opts.artifactStore ?? new InMemoryArtifactStore();

  const toolExecutorFactory =
    opts.withFactory === false
      ? undefined
      : new SandboxToolExecutorFactory({ sandboxClient, artifactStore });

  const router = new SessionRouter({
    eventLogStore,
    pendingEventStore,
    sessionStore,
    eventStreamHub,
    resolveAdapter: () => opts.adapter,
    toolExecutorFactory,
  });

  return {
    eventLogStore,
    pendingEventStore,
    sessionStore,
    eventStreamHub,
    sandboxClient,
    artifactStore,
    router,
  };
}

async function enqueue(
  pendingEventStore: PendingEventStore,
  sessionId: string,
  text: string,
) {
  await pendingEventStore.enqueue(sessionId, {
    type: "user.message",
    data: { content: [{ type: "text", text }] },
    sessionThreadId: "sthr_primary",
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("SessionRouter — sandbox-backed ToolExecutor injection (#42)", () => {
  it("a pure-chat turn creates NO sandbox (lazy)", async () => {
    const { router, sessionStore, pendingEventStore, sandboxClient } = createDeps({
      adapter: chatAdapter,
    });
    const session = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: "agent_sbx",
      agent: sandboxedAgent,
      workspaceId: "ws_1",
    });
    await enqueue(pendingEventStore, session.id, "hi");

    await router.handleNewEvent(session.id, sandboxedAgent);

    expect(sandboxClient.created).toHaveLength(0);
    expect(sandboxClient.liveCount).toBe(0);
  });

  it("the first file/code tool call creates a sandbox lazily", async () => {
    const artifactStore = new InMemoryArtifactStore();
    artifactStore.seed("tenant_1", "ws_1", "hello.txt", "world");
    const { router, sessionStore, pendingEventStore, sandboxClient } = createDeps({
      adapter: toolReadingAdapter("hello.txt"),
      artifactStore,
    });
    const session = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: "agent_sbx",
      agent: sandboxedAgent,
      workspaceId: "ws_1",
    });
    await enqueue(pendingEventStore, session.id, "read the file");

    await router.handleNewEvent(session.id, sandboxedAgent);

    expect(sandboxClient.created).toHaveLength(1);
  });

  it("hydrates the sandbox from the S3 Workspace and a tool call reads a hydrated file", async () => {
    const artifactStore = new InMemoryArtifactStore();
    artifactStore.seed("tenant_1", "ws_1", "notes.md", "hydrated-content");
    const { router, sessionStore, pendingEventStore, eventLogStore, sandboxClient } =
      createDeps({
        adapter: toolReadingAdapter("notes.md"),
        artifactStore,
      });
    const session = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: "agent_sbx",
      agent: sandboxedAgent,
      workspaceId: "ws_1",
    });
    await enqueue(pendingEventStore, session.id, "read notes");

    await router.handleNewEvent(session.id, sandboxedAgent);

    // The hydrated file landed in the sandbox under /workspace.
    const id = sandboxClient.created[0];
    expect(sandboxClient.filesOf(id).get("/workspace/notes.md")?.content).toBe(
      "hydrated-content",
    );

    // The adapter's tool call read it back and emitted it as a message.
    const { data } = await eventLogStore.getEvents(session.id, { limit: 100 });
    const message = data.find((e) => e.type === "agent.message");
    expect((message?.data as { content: Array<{ text: string }> }).content[0].text).toBe(
      "hydrated-content",
    );
  });

  it("destroys the sandbox at session end (terminateSession)", async () => {
    const artifactStore = new InMemoryArtifactStore();
    artifactStore.seed("tenant_1", "ws_1", "f.txt", "x");
    const { router, sessionStore, pendingEventStore, sandboxClient } = createDeps({
      adapter: toolReadingAdapter("f.txt"),
      artifactStore,
    });
    const session = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: "agent_sbx",
      agent: sandboxedAgent,
      workspaceId: "ws_1",
    });
    await enqueue(pendingEventStore, session.id, "read");
    await router.handleNewEvent(session.id, sandboxedAgent);

    expect(sandboxClient.liveCount).toBe(1);
    const id = sandboxClient.created[0];

    await router.terminateSession(session.id);

    expect(sandboxClient.destroyed).toEqual([id]);
    expect(sandboxClient.liveCount).toBe(0);
  });

  it("reuses one sandbox across turns and destroys it once at session end", async () => {
    const artifactStore = new InMemoryArtifactStore();
    artifactStore.seed("tenant_1", "ws_1", "f.txt", "x");
    const { router, sessionStore, pendingEventStore, sandboxClient } = createDeps({
      adapter: toolReadingAdapter("f.txt"),
      artifactStore,
    });
    const session = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: "agent_sbx",
      agent: sandboxedAgent,
      workspaceId: "ws_1",
    });

    await enqueue(pendingEventStore, session.id, "turn 1");
    await router.handleNewEvent(session.id, sandboxedAgent);
    await enqueue(pendingEventStore, session.id, "turn 2");
    await router.handleNewEvent(session.id, sandboxedAgent);

    expect(sandboxClient.created).toHaveLength(1);

    await router.terminateSession(session.id);
    expect(sandboxClient.destroyed).toHaveLength(1);
  });

  it("does not inject an executor for a non-sandboxed agent", async () => {
    let sawExecutor = true;
    const probeAdapter: Adapter = {
      async *run(input: AdapterInput): AsyncIterable<SessionEvent> {
        sawExecutor = input.toolExecutor != null;
        yield {
          id: "e",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text: "ok" }],
        };
      },
    };
    const { router, sessionStore, pendingEventStore, sandboxClient } = createDeps({
      adapter: probeAdapter,
    });
    const session = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: "agent_plain",
      agent: plainAgent,
      workspaceId: "ws_1",
    });
    await enqueue(pendingEventStore, session.id, "hi");

    await router.handleNewEvent(session.id, plainAgent);

    expect(sawExecutor).toBe(false);
    expect(sandboxClient.created).toHaveLength(0);
  });

  it("does not inject an executor when no factory is configured", async () => {
    let sawExecutor = true;
    const probeAdapter: Adapter = {
      async *run(input: AdapterInput): AsyncIterable<SessionEvent> {
        sawExecutor = input.toolExecutor != null;
        yield {
          id: "e",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text: "ok" }],
        };
      },
    };
    const { router, sessionStore, pendingEventStore } = createDeps({
      adapter: probeAdapter,
      withFactory: false,
    });
    const session = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: "agent_sbx",
      agent: sandboxedAgent,
      workspaceId: "ws_1",
    });
    await enqueue(pendingEventStore, session.id, "hi");

    await router.handleNewEvent(session.id, sandboxedAgent);

    expect(sawExecutor).toBe(false);
  });

  it("isolates concurrent sessions in distinct sandboxes (no cross-session bleed)", async () => {
    const artifactStore = new InMemoryArtifactStore();
    artifactStore.seed("tenant_1", "ws_a", "who.txt", "session-A");
    artifactStore.seed("tenant_1", "ws_b", "who.txt", "session-B");
    const { router, sessionStore, pendingEventStore, eventLogStore, sandboxClient } =
      createDeps({
        adapter: toolReadingAdapter("who.txt"),
        artifactStore,
      });

    const a = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: "agent_sbx",
      agent: sandboxedAgent,
      workspaceId: "ws_a",
    });
    const b = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: "agent_sbx",
      agent: sandboxedAgent,
      workspaceId: "ws_b",
    });
    await enqueue(pendingEventStore, a.id, "read");
    await enqueue(pendingEventStore, b.id, "read");

    await Promise.all([
      router.handleNewEvent(a.id, sandboxedAgent),
      router.handleNewEvent(b.id, sandboxedAgent),
    ]);

    // Two distinct sandboxes, each hydrated from its own Workspace.
    expect(sandboxClient.created).toHaveLength(2);

    const textOf = async (sessionId: string) => {
      const { data } = await eventLogStore.getEvents(sessionId, { limit: 100 });
      const msg = data.find((e) => e.type === "agent.message");
      return (msg?.data as { content: Array<{ text: string }> }).content[0].text;
    };
    expect(await textOf(a.id)).toBe("session-A");
    expect(await textOf(b.id)).toBe("session-B");
  });
});

// ─── Host-emitted workspace.file_change on sync (#43) ───────────────────────

/** Collect all SSE frame event types seen on a session's live stream. */
async function collectEventTypes(sub: {
  stream: ReadableStream<string>;
}): Promise<string[]> {
  const reader = sub.stream.getReader();
  const types: string[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const m = value.match(/^event: (.+)$/m);
    if (m) types.push(m[1]);
  }
  return types;
}

describe("SessionRouter — Host emits workspace.file_change on sync (#43)", () => {
  it("emits workspace.file_change on sync completion; the Adapter emits none", async () => {
    const { router, sessionStore, pendingEventStore, eventLogStore, eventStreamHub } =
      createDeps({ adapter: toolWritingAdapter("created.txt", "hi") });
    const session = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: "agent_sbx",
      agent: sandboxedAgent,
      workspaceId: "ws_1",
    });

    // Subscribe (with chunks) to capture the live SSE emit.
    const sub = eventStreamHub.subscribe(session.id, { includeChunks: true });

    await enqueue(pendingEventStore, session.id, "make a file");
    await router.handleNewEvent(session.id, sandboxedAgent);
    sub.unsubscribe();

    // Persisted: exactly one workspace.file_change, listing the new file.
    const { data } = await eventLogStore.getEvents(session.id, { limit: 100 });
    const fileChanges = data.filter((e) => e.type === "workspace.file_change");
    expect(fileChanges).toHaveLength(1);
    expect(fileChanges[0].data).toMatchObject({
      workspaceId: "ws_1",
      changed: ["created.txt"],
      deleted: [],
    });

    // The Host owns the event: its seq shows it went through the event log.
    expect(fileChanges[0].seq).toBeGreaterThan(0);

    // The adapter emitted only its plain message — no workspace/artifact event.
    const agentMessages = data.filter((e) => e.type === "agent.message");
    expect(agentMessages).toHaveLength(1);

    // Live SSE stream carried the file-change frame too.
    const liveTypes = await collectEventTypes(sub);
    expect(liveTypes).toContain("workspace.file_change");
  });

  it("a pure-chat turn emits NO workspace.file_change (sync no-op)", async () => {
    const { router, sessionStore, pendingEventStore, eventLogStore } = createDeps({
      adapter: chatAdapter,
    });
    const session = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: "agent_sbx",
      agent: sandboxedAgent,
      workspaceId: "ws_1",
    });
    await enqueue(pendingEventStore, session.id, "just chat");
    await router.handleNewEvent(session.id, sandboxedAgent);

    const { data } = await eventLogStore.getEvents(session.id, { limit: 100 });
    expect(data.filter((e) => e.type === "workspace.file_change")).toHaveLength(0);
  });

  it("propagates a delete: a hydrated file removed via bash emits it in deleted[]", async () => {
    const artifactStore = new InMemoryArtifactStore();
    artifactStore.seed("tenant_1", "ws_1", "doomed.txt", "x");

    // Fake sandbox whose exec understands `rm <abs-path>` by mutating its map,
    // so the file is removed by shell (not a tool) before the Host's sync.
    const sandboxClient = new FakeSandboxClient({
      execHandler: (command, files) => {
        if (command[0] === "rm" && command[1]) {
          files.delete(command[1]);
          return [];
        }
        return undefined;
      },
    });

    // Adapter runs `rm /workspace/doomed.txt` through the injected executor.
    const removingAdapter: Adapter = {
      async *run(input: AdapterInput): AsyncIterable<SessionEvent> {
        const executor = input.toolExecutor;
        if (executor) {
          for await (const _ of executor.exec(["rm", "/workspace/doomed.txt"])) {
            // discard output
          }
        }
        yield {
          id: "e",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text: "removed" }],
        };
      },
    };

    const { router, sessionStore, pendingEventStore, eventLogStore } = createDeps({
      adapter: removingAdapter,
      artifactStore,
      sandboxClient,
    });
    const session = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: "agent_sbx",
      agent: sandboxedAgent,
      workspaceId: "ws_1",
    });

    await enqueue(pendingEventStore, session.id, "remove it");
    await router.handleNewEvent(session.id, sandboxedAgent);

    const { data } = await eventLogStore.getEvents(session.id, { limit: 100 });
    const fileChanges = data.filter((e) => e.type === "workspace.file_change");
    expect(fileChanges).toHaveLength(1);
    expect(fileChanges[0].data).toMatchObject({ deleted: ["doomed.txt"] });
  });
});
