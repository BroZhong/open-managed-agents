import { beforeEach, describe, it, expect } from "vitest";
import { SessionRouter } from "../src/session-router.js";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { InMemoryAgentStore } from "@oma-server/store-memory";
import {
  FakeSandboxClient,
  FakeProvisionSource,
  DefaultSandboxManager,
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
  AgentStore,
  Skill,
  SkillStore,
  SkillStoreCreateInput,
  SkillStoreUpdateInput,
  SkillOwnerType,
  SkillArtifactStore,
  SkillFile,
} from "@oma-server/store";
import type {
  Adapter,
  AdapterInput,
  SessionEvent,
} from "@open-managed-agents/adapter-core";

beforeEach(() => {
  process.env.OMA_SUPABASE_ALLOWED_TENANTS = "tenant_1";
});

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

  async setTitle(id: string, title: string): Promise<Session | null> {
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

// ─── Minimal in-memory Skill stores (metadata + non-empty check) ─────────────
//
// The router's projection selection reads Skill metadata (existence, tenant,
// ownership) via SkillStore and confirms non-empty via SkillArtifactStore.list.
// The Skill CONTENT flows S3→sandbox through the FakeProvisionSource (seeded
// separately), so these stores only need to answer the include/skip decision.

class TinySkillStore implements SkillStore {
  private skills: Skill[] = [];
  private nextId = 1;

  async create(input: SkillStoreCreateInput): Promise<Skill> {
    const now = new Date();
    const ownerType: SkillOwnerType = input.ownerType ?? "library";
    const ownerId = input.ownerId ?? (ownerType === "library" ? input.tenantId : "");
    const skill: Skill = {
      id: `skl_${this.nextId++}`,
      tenantId: input.tenantId,
      name: input.name,
      description: input.description,
      ownerType,
      ownerId,
      sourceSkillId: input.sourceSkillId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.skills.push(skill);
    return skill;
  }
  async getById(id: string): Promise<Skill | null> {
    return this.skills.find((s) => s.id === id) ?? null;
  }
  async list(tenantId: string): Promise<PaginatedResult<Skill>> {
    const data = this.skills.filter(
      (s) => s.tenantId === tenantId && s.ownerType === "library",
    );
    return { data, hasMore: false };
  }
  async listByOwner(
    tenantId: string,
    ownerType: SkillOwnerType,
    ownerId: string,
  ): Promise<Skill[]> {
    return this.skills.filter(
      (s) => s.tenantId === tenantId && s.ownerType === ownerType && s.ownerId === ownerId,
    );
  }
  async update(id: string, input: SkillStoreUpdateInput): Promise<Skill | null> {
    const skill = this.skills.find((s) => s.id === id);
    if (!skill) return null;
    if (input.name !== undefined) skill.name = input.name;
    if (input.description !== undefined) skill.description = input.description;
    return skill;
  }
  async delete(id: string): Promise<boolean> {
    const before = this.skills.length;
    this.skills = this.skills.filter((s) => s.id !== id);
    return this.skills.length < before;
  }
}

class TinySkillArtifactStore implements SkillArtifactStore {
  private readonly files = new Map<string, Uint8Array>();
  private key(t: string, s: string, p: string) {
    return `${t}/${s}/${p}`;
  }
  async put(t: string, s: string, p: string, body: Uint8Array | string): Promise<void> {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    this.files.set(this.key(t, s, p), bytes);
  }
  async list(t: string, s: string): Promise<string[]> {
    const prefix = `${t}/${s}/`;
    const out: string[] = [];
    for (const k of this.files.keys()) if (k.startsWith(prefix)) out.push(k.slice(prefix.length));
    return out;
  }
  async get(t: string, s: string, p: string): Promise<Uint8Array | null> {
    return this.files.get(this.key(t, s, p)) ?? null;
  }
  async getAll(t: string, s: string): Promise<SkillFile[]> {
    const prefix = `${t}/${s}/`;
    const out: SkillFile[] = [];
    for (const [k, body] of this.files) {
      if (k.startsWith(prefix)) out.push({ path: k.slice(prefix.length), body });
    }
    return out;
  }
  async delete(t: string, s: string, p: string): Promise<void> {
    this.files.delete(this.key(t, s, p));
  }
  async move(t: string, s: string, from: string, to: string): Promise<void> {
    const b = this.files.get(this.key(t, s, from));
    if (!b) return;
    this.files.set(this.key(t, s, to), b);
    this.files.delete(this.key(t, s, from));
  }
  async deleteTree(t: string, s: string): Promise<void> {
    const prefix = `${t}/${s}/`;
    for (const k of [...this.files.keys()]) if (k.startsWith(prefix)) this.files.delete(k);
  }
  async copyTree(t: string, from: string, to: string): Promise<void> {
    for (const f of await this.getAll(t, from)) await this.put(t, to, f.path, f.body);
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
 * echoes it back, proving a tool call runs against the mounted Workspace.
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

/** Explicitly opts out of the mandatory sandbox (sandbox.enabled === false). */
const optedOutAgent: Agent = {
  id: "agent_optout",
  tenantId: "tenant_1",
  name: "Opted out",
  model: "claude-3",
  system: "helpful",
  runtime: "pi-agent",
  sandbox: { enabled: false },
  createdAt: new Date(),
  updatedAt: new Date(),
};

/** Legacy agent with NO sandbox field — treated as sandboxed by default (#54). */
const legacyAgent: Agent = {
  id: "agent_legacy",
  tenantId: "tenant_1",
  name: "Legacy",
  model: "claude-3",
  system: "helpful",
  runtime: "pi-agent",
  createdAt: new Date(),
  updatedAt: new Date(),
};

/**
 * Wire the real Sandbox Manager with a shared mounted Workspace and the
 * external Skill projection fixture. The Router still owns the complete
 * Session lifecycle and emits the durable completion/error events.
 */
function createDeps(opts: {
  adapter: Adapter;
  sandboxClient?: FakeSandboxClient;
  provisionSource?: FakeProvisionSource;
  skillStore?: SkillStore;
  skillArtifactStore?: SkillArtifactStore;
  agentStore?: AgentStore;
  withManager?: boolean;
  defaultSandboxEnv?: Record<string, string>;
  managedSandboxEnvByAgentId?: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
}) {
  const eventLogStore = new InMemoryEventLogStore();
  const pendingEventStore = new InMemoryPendingEventStore();
  const sessionStore = new InMemorySessionStore();
  const eventStreamHub = new InProcessEventStreamHub();
  const sandboxClient = opts.sandboxClient ?? new FakeSandboxClient();
  const provisionSource = opts.provisionSource ?? new FakeProvisionSource();

  const sandboxManager =
    opts.withManager === false
      ? undefined
      : new DefaultSandboxManager({
          sandboxClient,
          // Register the fake under kind "s3" so the router's { kind: "s3" }
          // projection coordinates dispatch to it (proving kind-based dispatch).
          provisionSources: { s3: provisionSource },
        });

  const router = new SessionRouter({
    eventLogStore,
    pendingEventStore,
    sessionStore,
    eventStreamHub,
    resolveAdapter: () => opts.adapter,
    sandboxManager,
    workspaceMount: {
      bucket: "agentry",
      agentName: "agentry-workspace",
      pvName: "agentry-workspace-oss",
      credentialProviderName: "agentry-oss-rw",
    },
    skillStore: opts.skillStore,
    skillArtifactStore: opts.skillArtifactStore,
    agentStore: opts.agentStore,
    defaultSandboxEnv: opts.defaultSandboxEnv,
    managedSandboxEnvByAgentId: opts.managedSandboxEnvByAgentId,
  });

  return {
    eventLogStore,
    pendingEventStore,
    sessionStore,
    eventStreamHub,
    sandboxClient,
    provisionSource,
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

// ─── SandboxSession injection (#42, now via SandboxManager #77/#78) ──────────

describe("SessionRouter — SandboxManager-backed session injection", () => {
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
    const workspaceClient = new FakeSandboxClient();
    workspaceClient.seedWorkspace("tenant_1/ws_1/", "hello.txt", "world");
    const { router, sessionStore, pendingEventStore, sandboxClient } = createDeps({
      adapter: toolReadingAdapter("hello.txt"),
      sandboxClient: workspaceClient,
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

  it("injects the Agent's sandbox.env into the created sandbox", async () => {
    const workspaceClient = new FakeSandboxClient();
    workspaceClient.seedWorkspace("tenant_1/ws_1/", "hello.txt", "world");
    const { router, sessionStore, pendingEventStore, sandboxClient } = createDeps({
      adapter: toolReadingAdapter("hello.txt"),
      sandboxClient: workspaceClient,
    });
    const envAgent: Agent = {
      ...sandboxedAgent,
      sandbox: { enabled: true, image: "ubuntu:22.04", env: { VFS_TOKEN: "tok-123" } },
    };
    const session = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: envAgent.id,
      agent: envAgent,
      workspaceId: "ws_1",
    });
    await enqueue(pendingEventStore, session.id, "read the file");

    await router.handleNewEvent(session.id, envAgent);

    expect(sandboxClient.created).toHaveLength(1);
    const id = sandboxClient.created[0];
    // The per-Agent env must reach the sandbox's create options.
    expect(sandboxClient.createOptsOf(id).env).toMatchObject({
      VFS_TOKEN: "tok-123",
    });
  });

  it("merges defaultSandboxEnv into the sandbox; the Agent's own env wins per key", async () => {
    const workspaceClient = new FakeSandboxClient();
    workspaceClient.seedWorkspace("tenant_1/ws_1/", "hello.txt", "world");
    const { router, sessionStore, pendingEventStore, sandboxClient } = createDeps({
      adapter: toolReadingAdapter("hello.txt"),
      sandboxClient: workspaceClient,
      // Deployment-wide defaults: a shared VFS_TOKEN plus an extra shared key.
      defaultSandboxEnv: { VFS_TOKEN: "default-tok", SHARED: "yes" },
    });
    const envAgent: Agent = {
      ...sandboxedAgent,
      // The Agent overrides VFS_TOKEN and adds its own key; SHARED is inherited.
      sandbox: { enabled: true, image: "ubuntu:22.04", env: { VFS_TOKEN: "agent-tok", OWN: "1" } },
    };
    const session = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: envAgent.id,
      agent: envAgent,
      workspaceId: "ws_1",
    });
    await enqueue(pendingEventStore, session.id, "read the file");

    await router.handleNewEvent(session.id, envAgent);

    const id = sandboxClient.created[0];
    const env = sandboxClient.createOptsOf(id).env;
    expect(env).toMatchObject({
      VFS_TOKEN: "agent-tok", // Agent wins over the default
      SHARED: "yes", // inherited from the deployment default
      OWN: "1", // the Agent's own extra key
    });
  });

  it("injects defaultSandboxEnv even when the Agent sets no sandbox.env", async () => {
    const workspaceClient = new FakeSandboxClient();
    workspaceClient.seedWorkspace("tenant_1/ws_1/", "hello.txt", "world");
    const { router, sessionStore, pendingEventStore, sandboxClient } = createDeps({
      adapter: toolReadingAdapter("hello.txt"),
      sandboxClient: workspaceClient,
      defaultSandboxEnv: { VFS_TOKEN: "default-tok" },
    });
    // sandboxedAgent has no sandbox.env of its own.
    const session = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: sandboxedAgent.id,
      agent: sandboxedAgent,
      workspaceId: "ws_1",
    });
    await enqueue(pendingEventStore, session.id, "read the file");

    await router.handleNewEvent(session.id, sandboxedAgent);

    const id = sandboxClient.created[0];
    expect(sandboxClient.createOptsOf(id).env).toMatchObject({
      VFS_TOKEN: "default-tok",
    });
  });

  it("passes shared base credentials to native sandbox creation for existing and future Agents", async () => {
    const workspaceClient = new FakeSandboxClient();
    workspaceClient.seedWorkspace("tenant_1/ws_1/", "hello.txt", "world");
    const baseEnv = {
      OSS_READ_ACCESS_KEY_ID: "base-oss-id",
      OSS_READ_ACCESS_KEY_SECRET: "base-oss-secret",
      OPENGROVE_WW_ACCESS_TOKEN: "base-ww-token",
    };
    const { router, sessionStore, pendingEventStore, sandboxClient } = createDeps({
      adapter: toolReadingAdapter("hello.txt"),
      sandboxClient: workspaceClient,
      defaultSandboxEnv: baseEnv,
    });

    for (const agentId of ["agent_existing_without_env", "agent_created_later"]) {
      const agent: Agent = { ...sandboxedAgent, id: agentId, sandbox: { enabled: true } };
      const session = await sessionStore.create({
        tenantId: "tenant_1", agentId, agent, workspaceId: "ws_1",
      });
      await enqueue(pendingEventStore, session.id, "read the file");
      await router.handleNewEvent(session.id, agent);
      expect((await sessionStore.getById(session.id))?.agent.sandbox?.env).toBeUndefined();
    }

    expect(sandboxClient.created).toHaveLength(2);
    for (const id of sandboxClient.created) {
      expect(sandboxClient.createOptsOf(id).env).toMatchObject(baseEnv);
    }
  });

  it("keeps deployment-managed sandbox env authoritative over Agent overrides", async () => {
    const workspaceClient = new FakeSandboxClient();
    workspaceClient.seedWorkspace("tenant_1/ws_1/", "hello.txt", "world");
    const { router, sessionStore, pendingEventStore, sandboxClient } = createDeps({
      adapter: toolReadingAdapter("hello.txt"),
      sandboxClient: workspaceClient,
      defaultSandboxEnv: { VFS_TOKEN: "default-vfs" },
      managedSandboxEnvByAgentId: {
        [sandboxedAgent.id]: {
          OPENGROVE_WW_BASE_URL: "https://managed.example.test",
          OPENGROVE_WW_ACCESS_TOKEN: "managed-token",
        },
      },
    });
    const envAgent: Agent = {
      ...sandboxedAgent,
      sandbox: {
        enabled: true,
        env: {
          VFS_TOKEN: "agent-vfs",
          OPENGROVE_WW_BASE_URL: "https://agent.example.test",
          OPENGROVE_WW_ACCESS_TOKEN: "agent-token",
        },
      },
    };
    const session = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: envAgent.id,
      agent: envAgent,
      workspaceId: "ws_1",
    });
    await enqueue(pendingEventStore, session.id, "read the file");

    await router.handleNewEvent(session.id, envAgent);

    const id = sandboxClient.created[0];
    expect(sandboxClient.createOptsOf(id).env).toMatchObject({
      VFS_TOKEN: "agent-vfs",
      OPENGROVE_WW_BASE_URL: "https://managed.example.test",
      OPENGROVE_WW_ACCESS_TOKEN: "managed-token",
    });
  });

  it("does not inject one Agent's managed sandbox env into another Agent", async () => {
    const workspaceClient = new FakeSandboxClient();
    workspaceClient.seedWorkspace("tenant_1/ws_1/", "hello.txt", "world");
    const { router, sessionStore, pendingEventStore, sandboxClient } = createDeps({
      adapter: toolReadingAdapter("hello.txt"),
      sandboxClient: workspaceClient,
      defaultSandboxEnv: { VFS_TOKEN: "default-vfs" },
      managedSandboxEnvByAgentId: {
        agent_allowed: {
          OPENGROVE_WW_BASE_URL: "https://managed.example.test",
          OPENGROVE_WW_ACCESS_TOKEN: "managed-token",
        },
      },
    });
    const session = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: sandboxedAgent.id,
      agent: sandboxedAgent,
      workspaceId: "ws_1",
    });
    await enqueue(pendingEventStore, session.id, "read the file");

    await router.handleNewEvent(session.id, sandboxedAgent);

    const id = sandboxClient.created[0];
    expect(sandboxClient.createOptsOf(id).env).toMatchObject({
      VFS_TOKEN: "default-vfs",
    });
    expect(sandboxClient.createOptsOf(id).env).not.toHaveProperty("OPENGROVE_WW_ACCESS_TOKEN");
  });

  it("reads an existing Workspace file through its verified mount", async () => {
    const workspaceClient = new FakeSandboxClient();
    workspaceClient.seedWorkspace("tenant_1/ws_1/", "notes.md", "mounted-content");
    const { router, sessionStore, pendingEventStore, eventLogStore, sandboxClient } =
      createDeps({
        adapter: toolReadingAdapter("notes.md"),
        sandboxClient: workspaceClient,
      });
    const session = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: "agent_sbx",
      agent: sandboxedAgent,
      workspaceId: "ws_1",
    });
    await enqueue(pendingEventStore, session.id, "read notes");

    await router.handleNewEvent(session.id, sandboxedAgent);

    // The file is visible at the fixed Workspace mount while HOME stays local.
    const id = sandboxClient.created[0];
    expect(await sandboxClient.readFile(id, "/home/user/workspace/notes.md")).toBe(
      "mounted-content",
    );

    // The adapter's tool call read it back and emitted it as a message.
    const { data } = await eventLogStore.getEvents(session.id, { limit: 100 });
    const message = data.find((e) => e.type === "agent.message");
    expect((message?.data as { content: Array<{ text: string }> }).content[0].text).toBe(
      "mounted-content",
    );
  });

  it("destroys the sandbox at session end (terminateSession)", async () => {
    const workspaceClient = new FakeSandboxClient();
    workspaceClient.seedWorkspace("tenant_1/ws_1/", "f.txt", "x");
    const { router, sessionStore, pendingEventStore, sandboxClient } = createDeps({
      adapter: toolReadingAdapter("f.txt"),
      sandboxClient: workspaceClient,
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
    expect(workspaceClient.workspaceContents("tenant_1/ws_1/").get("f.txt")?.content).toBe("x");

    const replacement = await sessionStore.create({
      tenantId: "tenant_1", agentId: sandboxedAgent.id, agent: sandboxedAgent, workspaceId: "ws_1",
    });
    await enqueue(pendingEventStore, replacement.id, "read retained Workspace");
    await router.handleNewEvent(replacement.id, sandboxedAgent);
    expect(sandboxClient.created).toHaveLength(2);
    expect(await sandboxClient.readFile(sandboxClient.created[1], "/home/user/workspace/f.txt")).toBe("x");
  });

  it("reuses one sandbox across turns and destroys it once at session end", async () => {
    const workspaceClient = new FakeSandboxClient();
    workspaceClient.seedWorkspace("tenant_1/ws_1/", "f.txt", "x");
    const { router, sessionStore, pendingEventStore, sandboxClient } = createDeps({
      adapter: toolReadingAdapter("f.txt"),
      sandboxClient: workspaceClient,
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

  it("retries Session disposal after a transient destroy failure and retains Workspace files", async () => {
    class FailsFirstDestroyClient extends FakeSandboxClient {
      private attempts = 0;
      override async destroy(id: string): Promise<void> {
        if (++this.attempts === 1) throw new Error("temporary gateway failure");
        return super.destroy(id);
      }
    }
    const sandboxClient = new FailsFirstDestroyClient();
    sandboxClient.seedWorkspace("tenant_1/ws_1/", "saved.txt", "retained");
    const { router, sessionStore, pendingEventStore } = createDeps({ adapter: toolReadingAdapter("saved.txt"), sandboxClient });
    const session = await sessionStore.create({ tenantId: "tenant_1", agentId: sandboxedAgent.id, agent: sandboxedAgent, workspaceId: "ws_1" });
    await enqueue(pendingEventStore, session.id, "read");
    await router.handleNewEvent(session.id, sandboxedAgent);
    await expect(router.terminateSession(session.id)).rejects.toThrow("temporary gateway failure");
    expect(sandboxClient.liveCount).toBe(1);
    await router.terminateSession(session.id);
    expect(sandboxClient.liveCount).toBe(0);
    expect(sandboxClient.destroyed).toEqual(sandboxClient.created);
    expect(sandboxClient.workspaceContents("tenant_1/ws_1/").get("saved.txt")?.content).toBe("retained");
  });

  it("does not inject an executor for a non-sandboxed agent when a manager IS present", async () => {
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
    // Manager present, but the agent explicitly opts out of the sandbox.
    const { router, sessionStore, pendingEventStore, sandboxClient } = createDeps({
      adapter: probeAdapter,
    });
    const session = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: "agent_optout",
      agent: optedOutAgent,
      workspaceId: "ws_1",
    });
    await enqueue(pendingEventStore, session.id, "hi");

    await router.handleNewEvent(session.id, optedOutAgent);

    expect(sawExecutor).toBe(false);
    expect(sandboxClient.created).toHaveLength(0);
  });
});

// ─── Fail-loud: mandatory sandbox with no provisionable manager (#54) ────────

describe("SessionRouter — mandatory sandbox fail-loud (#54)", () => {
  it("emits session.error(sandbox_unavailable) and does NOT run the adapter when sandboxed but no manager", async () => {
    let adapterInvoked = false;
    const probeAdapter: Adapter = {
      async *run(_input: AdapterInput): AsyncIterable<SessionEvent> {
        adapterInvoked = true;
        yield {
          id: "e",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text: "should not run" }],
        };
      },
    };
    const { router, sessionStore, pendingEventStore, eventLogStore } = createDeps({
      adapter: probeAdapter,
      withManager: false,
    });
    const session = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: "agent_sbx",
      agent: sandboxedAgent,
      workspaceId: "ws_1",
    });
    await enqueue(pendingEventStore, session.id, "hi");

    await router.handleNewEvent(session.id, sandboxedAgent);

    // The adapter was skipped entirely — no unsandboxed fallback ran.
    expect(adapterInvoked).toBe(false);

    // A session.error with the sandbox_unavailable code was persisted.
    const { data } = await eventLogStore.getEvents(session.id, { limit: 100 });
    const errors = data.filter((e) => e.type === "session.error");
    expect(errors).toHaveLength(1);
    expect((errors[0].data as { error: { code: string } }).error.code).toBe(
      "sandbox_unavailable",
    );

    // No agent.message was emitted because the adapter never ran.
    expect(data.filter((e) => e.type === "agent.message")).toHaveLength(0);

    // The session still transitions back to idle so it isn't left running.
    const final = await sessionStore.getById(session.id);
    expect(final?.status).toBe("idle");
  });

  it("treats a legacy agent with NO sandbox field as sandboxed (fail-loud without a manager)", async () => {
    let adapterInvoked = false;
    const probeAdapter: Adapter = {
      async *run(_input: AdapterInput): AsyncIterable<SessionEvent> {
        adapterInvoked = true;
        yield {
          id: "e",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text: "x" }],
        };
      },
    };
    const { router, sessionStore, pendingEventStore, eventLogStore } = createDeps({
      adapter: probeAdapter,
      withManager: false,
    });
    const session = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: "agent_legacy",
      agent: legacyAgent,
      workspaceId: "ws_1",
    });
    await enqueue(pendingEventStore, session.id, "hi");

    await router.handleNewEvent(session.id, legacyAgent);

    expect(adapterInvoked).toBe(false);
    const { data } = await eventLogStore.getEvents(session.id, { limit: 100 });
    expect(
      data.some(
        (e) =>
          e.type === "session.error" &&
          (e.data as { error: { code: string } }).error.code === "sandbox_unavailable",
      ),
    ).toBe(true);
  });

  it("runs normally with an injected session when sandboxed AND a manager is present", async () => {
    const workspaceClient = new FakeSandboxClient();
    workspaceClient.seedWorkspace("tenant_1/ws_1/", "hello.txt", "world");
    const { router, sessionStore, pendingEventStore, eventLogStore, sandboxClient } =
      createDeps({
        adapter: toolReadingAdapter("hello.txt"),
        sandboxClient: workspaceClient,
      });
    const session = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: "agent_sbx",
      agent: sandboxedAgent,
      workspaceId: "ws_1",
    });
    await enqueue(pendingEventStore, session.id, "read the file");

    await router.handleNewEvent(session.id, sandboxedAgent);

    // The adapter ran with an injected session (a sandbox was created) and
    // there is no fail-loud session.error.
    expect(sandboxClient.created).toHaveLength(1);
    const { data } = await eventLogStore.getEvents(session.id, { limit: 100 });
    expect(
      data.some(
        (e) =>
          e.type === "session.error" &&
          (e.data as { error?: { code?: string } }).error?.code === "sandbox_unavailable",
      ),
    ).toBe(false);
    const msg = data.find((e) => e.type === "agent.message");
    expect((msg?.data as { content: Array<{ text: string }> }).content[0].text).toBe(
      "world",
    );
  });

  it("isolates concurrent sessions in distinct sandboxes (no cross-session bleed)", async () => {
    const workspaceClient = new FakeSandboxClient();
    workspaceClient.seedWorkspace("tenant_1/ws_a/", "who.txt", "session-A");
    workspaceClient.seedWorkspace("tenant_1/ws_b/", "who.txt", "session-B");
    const { router, sessionStore, pendingEventStore, eventLogStore, sandboxClient } =
      createDeps({
        adapter: toolReadingAdapter("who.txt"),
        sandboxClient: workspaceClient,
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

    // Two distinct sandboxes, each mounted to its own Workspace.
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

// ─── Turn completion and mounted Workspace integration ─────────────────────

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

describe("SessionRouter — Workspace availability after completed writes", () => {
  it("retains a completed answer when the storage check fails, blocks the next Turn, then recovers without replay", async () => {
    const sandboxClient = new FakeSandboxClient();
    let adapterRuns = 0;
    const adapter: Adapter = {
      async *run(input): AsyncIterable<SessionEvent> {
        adapterRuns++;
        await input.toolExecutor!.writeFile("saved.txt", `saved-${adapterRuns}`);
        if (adapterRuns === 1) sandboxClient.setMountFailure(sandboxClient.created[0], "storage offline");
        yield {
          id: `answer-${adapterRuns}`, timestamp: "2026-09-14T00:00:00.000Z", type: "agent.message",
          content: [{ type: "text", text: `answer-${adapterRuns}` }],
        };
      },
    };
    const { router, sessionStore, pendingEventStore, eventLogStore, eventStreamHub } = createDeps({ adapter, sandboxClient });
    const session = await sessionStore.create({
      tenantId: "tenant_1", agentId: sandboxedAgent.id, agent: sandboxedAgent, workspaceId: "ws_1",
    });
    const sub = eventStreamHub.subscribe(session.id, { includeChunks: true });
    await enqueue(pendingEventStore, session.id, "write and answer");
    await router.handleNewEvent(session.id, sandboxedAgent);
    sub.unsubscribe();

    const firstTurn = (await eventLogStore.getEvents(session.id, { limit: 100 })).data;
    expect(firstTurn.filter((event) => event.type === "agent.message")).toHaveLength(1);
    expect(firstTurn.find((event) => event.type === "agent.message")?.data).toMatchObject({ content: [{ type: "text", text: "answer-1" }] });
    expect(firstTurn.find((event) => event.type === "session.error")?.data).toMatchObject({ error: { code: "workspace_storage_error", message: expect.stringContaining("answer is retained") } });
    expect(firstTurn.filter((event) => event.type === "session.turn_completed")).toHaveLength(1);
    expect(firstTurn.filter((event) => event.type === "workspace.file_change")).toHaveLength(0);
    expect((await collectEventTypes(sub))).toContain("session.status_idle");
    expect((await sessionStore.getById(session.id))?.status).toBe("idle");
    expect(await pendingEventStore.count(session.id)).toBe(0);
    expect(sandboxClient.workspaceContents("tenant_1/ws_1/").get("saved.txt")?.content).toBe("saved-1");
    await router.handleNewEvent(session.id, sandboxedAgent);
    expect(adapterRuns).toBe(1);

    await enqueue(pendingEventStore, session.id, "cannot execute while unavailable");
    await router.handleNewEvent(session.id, sandboxedAgent);
    expect(adapterRuns).toBe(1);
    expect((await eventLogStore.getEvents(session.id, { limit: 100 })).data).toContainEqual(expect.objectContaining({
      type: "session.error", data: expect.objectContaining({ error: expect.objectContaining({ code: "sandbox_prepare_failed" }) }),
    }));
    sandboxClient.setMountFailure(sandboxClient.created[0]);
    await enqueue(pendingEventStore, session.id, "retry after recovery");
    await router.handleNewEvent(session.id, sandboxedAgent);
    expect(adapterRuns).toBe(2);
    expect(sandboxClient.created).toHaveLength(1);
    expect(sandboxClient.workspaceContents("tenant_1/ws_1/").get("saved.txt")?.content).toBe("saved-2");
    expect((await sessionStore.getById(session.id))?.status).toBe("idle");
  });

  it.each(["failure", "Interrupt"] as const)("retains closed files after an adapter %s and Session termination", async (outcome) => {
    let wrote!: () => void;
    const written = new Promise<void>((resolve) => { wrote = resolve; });
    const adapter: Adapter = {
      async *run(input): AsyncIterable<SessionEvent> {
        await input.toolExecutor!.writeFile("saved.txt", "closed before the Turn ended");
        wrote();
        if (outcome === "failure") throw new Error("adapter failed after saving");
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted) return resolve();
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    const { router, sessionStore, pendingEventStore, eventLogStore, sandboxClient } = createDeps({ adapter });
    const session = await sessionStore.create({
      tenantId: "tenant_1", agentId: sandboxedAgent.id, agent: sandboxedAgent, workspaceId: "ws_1",
    });
    await enqueue(pendingEventStore, session.id, "save a file");
    const running = router.handleNewEvent(session.id, sandboxedAgent);
    await written;
    if (outcome === "Interrupt") expect(router.interrupt(session.id)).toBe(true);
    await running;
    const events = (await eventLogStore.getEvents(session.id, { limit: 100 })).data;
    if (outcome === "Interrupt") expect(events.map((event) => event.type)).toContain("session.turn_aborted");
    else expect(events).toContainEqual(expect.objectContaining({
      type: "session.error", data: expect.objectContaining({ error: expect.objectContaining({ code: "adapter_error" }) }),
    }));
    expect(events.map((event) => event.type)).toContain("session.turn_completed");
    expect((await sessionStore.getById(session.id))?.status).toBe("idle");
    expect(await pendingEventStore.count(session.id)).toBe(0);
    await router.terminateSession(session.id);
    expect(sandboxClient.liveCount).toBe(0);
    expect(sandboxClient.workspaceContents("tenant_1/ws_1/").get("saved.txt")?.content).toBe("closed before the Turn ended");
  });
});

// ─── Integration slice (#78): the seams wired via the REAL manager + fakes ───

describe("SessionRouter — end-to-end integration (#78)", () => {
  it("state persists across turns: a file written in turn 1 is present in turn 2", async () => {
    // Closing the write persists its bytes; a later Turn reads the shared mount.
    const workspaceClient = new FakeSandboxClient();
    const readOrWrite: Adapter = {
      async *run(input: AdapterInput): AsyncIterable<SessionEvent> {
        const ex = input.toolExecutor!;
        const isWrite = input.message.content.some(
          (b) => b.type === "text" && b.text === "write",
        );
        let text: string;
        if (isWrite) {
          await ex.writeFile("carry.txt", "persisted-across-turns");
          text = "wrote";
        } else {
          text = await ex.readFile("carry.txt");
        }
        yield {
          id: "e",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text }],
        };
      },
    };
    const { router, sessionStore, pendingEventStore, eventLogStore, sandboxClient } =
      createDeps({ adapter: readOrWrite, sandboxClient: workspaceClient });
    const session = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: "agent_sbx",
      agent: sandboxedAgent,
      workspaceId: "ws_1",
    });

    await enqueue(pendingEventStore, session.id, "write");
    await router.handleNewEvent(session.id, sandboxedAgent);

    // The completed write is already visible through the storage boundary.
    expect(workspaceClient.workspaceContents("tenant_1/ws_1/").get("carry.txt")?.content).toBe(
      "persisted-across-turns",
    );

    await enqueue(pendingEventStore, session.id, "read");
    await router.handleNewEvent(session.id, sandboxedAgent);

    // One long-lived sandbox across both turns; turn 2 read the turn-1 file.
    expect(sandboxClient.created).toHaveLength(1);
    const { data } = await eventLogStore.getEvents(session.id, { limit: 100 });
    const messages = data.filter((e) => e.type === "agent.message");
    const last = messages[messages.length - 1];
    expect((last.data as { content: Array<{ text: string }> }).content[0].text).toBe(
      "persisted-across-turns",
    );
  });

  it("turn 2 sees idle-time Workspace edits from authoritative storage", async () => {
    const workspaceClient = new FakeSandboxClient();
    workspaceClient.seedWorkspace("tenant_1/ws_1/", "edit.txt", "before");
    workspaceClient.seedWorkspace("tenant_1/ws_1/", "deleted.txt", "remove me");
    const adapter: Adapter = {
      async *run(input: AdapterInput): AsyncIterable<SessionEvent> {
        const executor = input.toolExecutor!;
        const prompt = input.message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
        let text = await executor.readFile("edit.txt");
        if (prompt === "verify") {
          text += `|${await executor.readFile("added.txt")}`;
          try {
            await executor.readFile("deleted.txt");
            text += "|still-present";
          } catch {
            text += "|deleted";
          }
        }
        yield {
          id: "workspace-refresh",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text }],
        };
      },
    };
    const { router, sessionStore, pendingEventStore, eventLogStore, sandboxClient } =
      createDeps({ adapter, sandboxClient: workspaceClient });
    const session = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: sandboxedAgent.id,
      agent: sandboxedAgent,
      workspaceId: "ws_1",
    });

    await enqueue(pendingEventStore, session.id, "warm");
    await router.handleNewEvent(session.id, sandboxedAgent);
    workspaceClient.seedWorkspace("tenant_1/ws_1/", "edit.txt", "from web");
    workspaceClient.seedWorkspace("tenant_1/ws_1/", "added.txt", "new from web");
    workspaceClient.deleteWorkspaceFile("tenant_1/ws_1/", "deleted.txt");

    await enqueue(pendingEventStore, session.id, "verify");
    await router.handleNewEvent(session.id, sandboxedAgent);

    expect(sandboxClient.created).toHaveLength(1);
    const { data } = await eventLogStore.getEvents(session.id, { limit: 100 });
    const messages = data.filter((event) => event.type === "agent.message");
    const last = messages.at(-1)!;
    expect((last.data as { content: Array<{ text: string }> }).content[0].text).toBe(
      "from web|new from web|deleted",
    );
  });

  it("the model can read an equipped Skill from inside the sandbox (/skills/<skill-name>/SKILL.md)", async () => {
    // Seed the FakeProvisionSource with a Skill's SKILL.md, equip it on the
    // agent, run a turn, and assert the session can read it at /skills/<skill-name> —
    // proving Skills-as-projection works end to end (ADR-0005 §4).
    const skillStore = new TinySkillStore();
    const skillArtifactStore = new TinySkillArtifactStore();
    const skill = await skillStore.create({
      tenantId: "tenant_1",
      name: "greeter",
      description: "greets",
      ownerType: "agent",
      ownerId: "agent_sbx",
    });
    const SKILL_BODY = "---\nname: greeter\n---\nsay hi";
    // The router's non-empty check reads the artifact store; the CONTENT is
    // projected S3→sandbox by the FakeProvisionSource, so seed both.
    await skillArtifactStore.put("tenant_1", skill.id, "SKILL.md", SKILL_BODY);
    const provisionSource = new FakeProvisionSource();
    provisionSource.seed(
      { kind: "s3", ref: { tenantId: "tenant_1", skillId: skill.id } },
      { "SKILL.md": SKILL_BODY },
    );

    let readBody = "<unread>";
    let descriptors: AdapterInput["agent"]["skillDescriptors"];
    const skillReadingAdapter: Adapter = {
      async *run(input: AdapterInput): AsyncIterable<SessionEvent> {
        descriptors = input.agent.skillDescriptors;
        // The adapter is pointed at the in-sandbox /skills/<skill-name> root and reads
        // SKILL.md from there, exactly as Pi's sandbox-mapped read would.
        const root = input.agent.skillPaths?.[0];
        // Projections live outside /home/user/workspace, so read via an absolute-path
        // exec (cat) — the FakeSandboxClient's built-in cat reads any abs path.
        for await (const chunk of input.toolExecutor!.exec(["cat", `${root}/SKILL.md`])) {
          if (chunk.stream === "stdout") readBody = chunk.text;
        }
        yield {
          id: "e",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text: readBody }],
        };
      },
    };

    const { router, sessionStore, pendingEventStore, sandboxClient } = createDeps({
      adapter: skillReadingAdapter,
      provisionSource,
      skillStore,
      skillArtifactStore,
    });
    const agent: Agent = { ...sandboxedAgent, skills: [skill.id] };
    const session = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: agent.id,
      agent,
      workspaceId: "ws_1",
    });

    await enqueue(pendingEventStore, session.id, "load the skill");
    await router.handleNewEvent(session.id, agent);

    // The projection landed at /skills/<skill-name>/SKILL.md and was readable inside the
    // sandbox with the seeded content.
    const id = sandboxClient.created[0];
    expect(sandboxClient.filesOf(id).get("/skills/greeter/SKILL.md")?.content).toBe(
      SKILL_BODY,
    );
    expect(readBody).toBe(SKILL_BODY);

    // Edit the Skill while the Session stays alive. The next turn must refresh
    // the same sandbox projection and rebuild prompt metadata from the store.
    const UPDATED_BODY = "---\nname: greeter-v2\n---\nsay hello";
    await skillStore.update(skill.id, {
      name: "greeter-v2",
      description: "greets better",
    });
    await skillArtifactStore.put("tenant_1", skill.id, "SKILL.md", UPDATED_BODY);
    provisionSource.seed(
      { kind: "s3", ref: { tenantId: "tenant_1", skillId: skill.id } },
      { "SKILL.md": UPDATED_BODY },
    );

    await enqueue(pendingEventStore, session.id, "load the edited skill");
    await router.handleNewEvent(session.id, agent);

    expect(sandboxClient.created).toHaveLength(1);
    expect(readBody).toBe(UPDATED_BODY);
    expect(sandboxClient.filesOf(id).has("/skills/greeter/SKILL.md")).toBe(false);
    expect(await sandboxClient.readFile(id, "/skills/greeter-v2/SKILL.md")).toBe(UPDATED_BODY);
    expect(descriptors).toEqual([
      {
        name: "greeter-v2",
        description: "greets better",
        path: "/skills/greeter-v2/SKILL.md",
      },
    ]);
  });

  it.each([["same", "same"], ["../escape"], ["nested/name"], ["."]])("rejects ambiguous or unsafe equipped Skill paths: %j", async (...names) => {
    const skillStore = new TinySkillStore();
    const skillArtifactStore = new TinySkillArtifactStore();
    const ids: string[] = [];
    for (const name of names) {
      const skill = await skillStore.create({ tenantId: "tenant_1", ownerType: "agent", ownerId: sandboxedAgent.id, name });
      ids.push(skill.id);
      await skillArtifactStore.put("tenant_1", skill.id, "SKILL.md", "body");
    }
    let adapterRan = false;
    const adapter: Adapter = {
      async *run(): AsyncIterable<SessionEvent> { adapterRan = true; },
    };
    const { router, sessionStore, pendingEventStore, eventLogStore, sandboxClient } = createDeps({ adapter, skillStore, skillArtifactStore });
    const agent = { ...sandboxedAgent, skills: ids };
    const session = await sessionStore.create({ tenantId: "tenant_1", agentId: agent.id, agent, workspaceId: "ws_1" });
    await enqueue(pendingEventStore, session.id, "load equipped Skills");
    await router.handleNewEvent(session.id, agent);
    expect(adapterRan).toBe(false);
    expect(sandboxClient.created).toHaveLength(0);
    expect((await eventLogStore.getEvents(session.id, { limit: 100 })).data).toContainEqual(expect.objectContaining({
      type: "session.error", data: expect.objectContaining({ error: expect.objectContaining({ code: "sandbox_prepare_failed" }) }),
    }));
    expect((await sessionStore.getById(session.id))?.status).toBe("idle");
  });

  it("an existing Session picks up live Agent system, newly equipped Skills, and MCP", async () => {
    const agentStore = new InMemoryAgentStore();
    const liveAgent = await agentStore.create({
      tenantId: "tenant_1",
      name: "Live Agent",
      model: "claude-3",
      system: "old system",
      runtime: "pi-agent",
      skills: [],
      sandbox: { enabled: true },
    });
    const skillStore = new TinySkillStore();
    const skillArtifactStore = new TinySkillArtifactStore();
    const skill = await skillStore.create({
      tenantId: "tenant_1",
      name: "late-skill",
      description: "equipped after session creation",
      ownerType: "agent",
      ownerId: liveAgent.id,
    });
    await skillArtifactStore.put("tenant_1", skill.id, "SKILL.md", "late body");
    const provisionSource = new FakeProvisionSource();
    provisionSource.seed(
      { kind: "s3", ref: { tenantId: "tenant_1", skillId: skill.id } },
      { "SKILL.md": "late body" },
    );

    const seen: Array<{
      system: string;
      body?: string;
      mcpConnections: Array<{
        name: string;
        command?: string;
        tenantId?: string;
        entrypoint?: string;
      }>;
    }> = [];
    const adapter: Adapter = {
      async *run(input: AdapterInput): AsyncIterable<SessionEvent> {
        const root = input.agent.skillPaths?.[0];
        let body: string | undefined;
        if (root) body = await input.toolExecutor!.readFile(`${root}/SKILL.md`);
        else await input.toolExecutor!.writeFile("warm.txt", "warm");
        seen.push({
          system: input.agent.system,
          body,
          mcpConnections: input.agent.mcpServers?.map((server) => ({
            name: server.name,
            ...( "command" in server
              ? {
                  command: server.command,
                  tenantId: server.env?.OMA_TENANT_ID,
                  entrypoint: server.args?.at(-1),
                }
              : {}),
          })) ?? [],
        });
        yield {
          id: "live-agent-config",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text: body ?? "warm" }],
        };
      },
    };
    const { router, sessionStore, pendingEventStore, sandboxClient } = createDeps({
      adapter,
      agentStore,
      provisionSource,
      skillStore,
      skillArtifactStore,
    });
    const session = await sessionStore.create({
      tenantId: "tenant_1",
      agentId: liveAgent.id,
      agent: { ...liveAgent },
      workspaceId: "ws_1",
    });

    await enqueue(pendingEventStore, session.id, "warm");
    await router.handleNewEvent(session.id, session.agent);
    await agentStore.update(liveAgent.id, {
      system: "new system",
      skills: [skill.id],
      mcpServers: [
        {
          catalogId: "aliyun-rds-supabase",
          name: "session-data",
          description: "Read recent Session data",
        },
      ],
    });
    await enqueue(pendingEventStore, session.id, "use newly equipped skill");
    await router.handleNewEvent(session.id, session.agent);

    expect(sandboxClient.created).toHaveLength(1);
    expect(seen).toEqual([
      { system: "old system", body: undefined, mcpConnections: [] },
      {
        system: "new system",
        body: "late body",
        mcpConnections: [{
          name: "session-data",
          command: process.execPath,
          tenantId: "tenant_1",
          entrypoint: expect.stringMatching(/supabase-session-mcp\.ts$/),
        }],
      },
    ]);
  });
});
