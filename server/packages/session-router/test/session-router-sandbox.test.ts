import { beforeEach, describe, it, expect, vi } from "vitest";
import { SessionRouter } from "../src/session-router.js";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { createMemoryStores, InMemoryAgentStore, InMemorySkillBundleStore, InMemorySkillStore } from "@oma-server/store-memory";
import { PendingEventClaimLostError, packSkillBundle } from "@oma-server/store";
import {
  FakeSandboxClient,
  DefaultSandboxManager,
  DefaultTurnSandboxes,
} from "@oma-server/sandbox";
import type {
  PendingEventStore,
  Agent,
  AgentStore,
  Skill,
  SkillStore,
  SkillStoreCreateInput,
} from "@oma-server/store";
import type {
  Adapter,
  AdapterInput,
  SessionEvent,
} from "@open-managed-agents/adapter-core";
import { journalWriter } from "@open-managed-agents/adapter-mock";

beforeEach(() => {
  process.env.OMA_SUPABASE_ALLOWED_TENANTS = "tenant_1";
});

// ─── Skills ──────────────────────────────────────────────────────────────────
//
// The router reads Skill metadata and each Skill's current bundle from the
// SkillStore; the Sandbox Manager installs the bundles from the bundle store.

/** Pack `files` into the bundle store and give the Skill that bundle. */
async function withBundle(bundles: InMemorySkillBundleStore, files: Record<string, string>) {
  const packed = await packSkillBundle(Object.entries(files).map(([path, body]) => ({ path, body: new TextEncoder().encode(body) })));
  await bundles.put("tenant_1", packed);
  return { bundleSha256: packed.sha256, bundleSize: packed.size };
}

async function createSkill(skills: SkillStore, bundles: InMemorySkillBundleStore, input: SkillStoreCreateInput, files: Record<string, string>) {
  return skills.create({ ...input, ...await withBundle(bundles, files) });
}

// ─── Adapters ────────────────────────────────────────────────────────────────

/** Pure-chat adapter: never touches input.toolExecutor. */
const chatAdapter: Adapter = {
  async run(input: AdapterInput) {
    const write = journalWriter(input);
    await write({
      id: "evt_chat",
      timestamp: "2024-01-01T00:00:00.000Z",
      type: "agent.message",
      content: [{ type: "text", text: "just chatting" }],
    });
    return "finished";
  },
};

/**
 * Tool-using adapter: reads a workspace file through the injected executor and
 * echoes it back, proving a tool call runs against the mounted Workspace.
 */
function toolReadingAdapter(path: string): Adapter {
  return {
    async run(input: AdapterInput) {
      const write = journalWriter(input);
      const executor = input.toolExecutor;
      let body = "<no-executor>";
      if (executor) {
        body = await executor.readFile(path);
      }
      await write({
        id: "evt_tool",
        timestamp: "2024-01-01T00:00:00.000Z",
        type: "agent.message",
        content: [{ type: "text", text: body }],
      });
      return "finished";
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
  sandbox: { enabled: true },
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
 * Wire the real Sandbox Manager with a shared mounted Workspace and an
 * in-memory Skill Bundle store, behind the Turn Sandboxes over the in-memory
 * Sandbox Bindings. The Router still owns the complete Session
 * lifecycle and emits the durable completion/error events.
 */
function createDeps(opts: {
  adapter: Adapter;
  sandboxClient?: FakeSandboxClient;
  skillBundleStore?: InMemorySkillBundleStore;
  skillStore?: SkillStore;
  agentStore?: AgentStore;
  withManager?: boolean;
  interruptedAdapterDrainTimeoutMs?: number;
}) {
  const { eventLogStore, pendingEventStore, sessionStore, delegationStore } = createMemoryStores();
  const eventStreamHub = new InProcessEventStreamHub();
  const sandboxClient = opts.sandboxClient ?? new FakeSandboxClient();
  const skillBundleStore = opts.skillBundleStore ?? new InMemorySkillBundleStore();

  const sandboxManager =
    opts.withManager === false
      ? undefined
      : new DefaultSandboxManager({ sandboxClient, skillBundleStore, environment: "test" });

  const router = new SessionRouter({
    interruptedAdapterDrainTimeoutMs: opts.interruptedAdapterDrainTimeoutMs,
    eventLogStore,
    pendingEventStore,
    sessionStore,
    eventStreamHub,
    resolveAdapter: () => opts.adapter,
    sandboxes: sandboxManager && new DefaultTurnSandboxes({
      manager: sandboxManager,
      bindings: delegationStore,
      sessions: sessionStore,
      workspaceMount: {
        bucket: "agentry",
        agentName: "agentry-workspace",
        pvName: "agentry-workspace-oss",
        credentialProviderName: "agentry-oss-rw",
      },
    }),
    skillStore: opts.skillStore,
    agentStore: opts.agentStore,
  });

  return {
    eventLogStore,
    pendingEventStore,
    sessionStore,
    eventStreamHub,
    sandboxClient,
    skillBundleStore,
    sandboxManager,
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
  it('observes settlement when termination races with a durable event write', async () => {
    let aborted = false;
    // The Router stops the attempt when a write through its Adapter's entry fails.
    const deps = createDeps({ adapter: { async run(input) {
      const write = journalWriter(input);
      await write({ id: 'racing-write', timestamp: new Date().toISOString(), type: 'agent.message', content: [{ type: 'text', text: 'revoked' }] }).catch(() => {});
      if (!input.signal!.aborted) await new Promise<void>(resolve => input.signal!.addEventListener('abort', () => resolve(), { once: true }));
      aborted = input.signal!.aborted;
      await write({ id: 'late-accounting', timestamp: new Date().toISOString(), type: 'agent.message', content: [{ type: 'text', text: 'revoked too' }] }).catch(() => {});
      return "finished";
    } } });
    vi.spyOn(deps.sandboxManager!, 'beginActivity').mockResolvedValue(true);
    const end = vi.spyOn(deps.sandboxManager!, 'finishActivity').mockResolvedValue();
    const session = await deps.sessionStore.create({ tenantId: 'tenant_1', agentId: sandboxedAgent.id, agent: sandboxedAgent, workspaceId: 'ws_1' });
    const append = deps.eventLogStore.append.bind(deps.eventLogStore);
    vi.spyOn(deps.eventLogStore, 'append').mockImplementation(async (id, event) => {
      if (event.type === 'agent.message') {
        await deps.sessionStore.terminate(id);
        const fence = event.pendingFence!;
        throw new PendingEventClaimLostError(id, fence.eventId, fence.ownerId, fence.generation);
      }
      return append(id, event);
    });
    await enqueue(deps.pendingEventStore, session.id, 'work');
    await deps.router.handleNewEvent(session.id, sandboxedAgent).catch(() => {});
    await vi.waitFor(() => expect(end).toHaveBeenCalledOnce(), { timeout: 200 });
    expect(aborted).toBe(true);
    expect((await deps.eventLogStore.getEvents(session.id)).data.some(e => e.type === 'agent.message')).toBe(false);
  });

  it.each([{ unknown: false, retry: false }, { unknown: true, retry: false }, { unknown: false, retry: true }])('observes natural runtime completion after termination accounting (remote unknown: $unknown, PG retry: $retry)', async ({ unknown, retry }) => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    const deps = createDeps({ adapter: { async run(input) {
      const write = journalWriter(input);
      await input.toolExecutor!.writeFile('saved.txt', 'preserved');
      started();
      await new Promise<void>(resolve => input.signal!.addEventListener('abort', () => resolve(), { once: true }));
      // Termination revoked the entry; the runtime still runs until it settles.
      await write({ id: 'late-accounting', timestamp: new Date().toISOString(), type: 'agent.message', content: [{ type: 'text', text: 'must not persist' }] }).catch(() => {});
      await settled;
      return "finished";
    } } });
    vi.spyOn(deps.sandboxClient, 'hasUncertainExecution').mockReturnValue(unknown);
    vi.spyOn(deps.sandboxManager!, 'beginActivity').mockResolvedValue(true);
    const end = vi.spyOn(deps.sandboxManager!, 'finishActivity').mockResolvedValue();
    if (retry) end.mockRejectedValueOnce(new Error('temporary PG outage'));
    const session = await deps.sessionStore.create({ tenantId: 'tenant_1', agentId: sandboxedAgent.id, agent: sandboxedAgent, workspaceId: 'ws_1' });
    await enqueue(deps.pendingEventStore, session.id, 'work');
    const running = deps.router.handleNewEvent(session.id, sandboxedAgent);
    await ready;
    await deps.sessionStore.terminate(session.id);
    expect(await deps.router.cleanupTerminatedSession(session.id)).toBe(false);
    await running;
    expect(end).not.toHaveBeenCalled();
    settle();
    if (unknown) {
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(end).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() => expect(end).toHaveBeenCalledOnce(), { timeout: 200 });
      if (retry) {
        await deps.router.cleanupTerminatedSession(session.id);
        expect(end).toHaveBeenCalledTimes(2);
        expect(end.mock.calls[1][0]).toEqual(end.mock.calls[0][0]);
      }
    }
    expect((await deps.eventLogStore.getEvents(session.id)).data.some(e => JSON.stringify(e.data).includes('must not persist'))).toBe(false);
  });

  it('retains an unknown remote operation even after the model runtime finishes', async () => {
    const deps = createDeps({ adapter: { async run(input) {
      await input.toolExecutor!.writeFile('saved.txt', 'closed');
      return "finished";
    } } });
    vi.spyOn(deps.sandboxClient, 'hasUncertainExecution').mockReturnValue(true);
    vi.spyOn(deps.sandboxManager!, 'beginActivity').mockResolvedValue(true);
    const end = vi.spyOn(deps.sandboxManager!, 'finishActivity').mockResolvedValue();
    const session = await deps.sessionStore.create({ tenantId: 'tenant_1', agentId: sandboxedAgent.id, agent: sandboxedAgent, workspaceId: 'ws_1' });
    await enqueue(deps.pendingEventStore, session.id, 'work');
    await deps.router.handleNewEvent(session.id, sandboxedAgent);
    expect(deps.sandboxClient.created).toHaveLength(1);
    expect(end).not.toHaveBeenCalled();
    expect((await deps.eventLogStore.getEvents(session.id)).data.map(event => event.type)).toContain('session.turn_completed');
  });
  it('retains activity when Interrupt gives up waiting for the runtime', async () => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let settle!: () => void;
    const eventuallySettled = new Promise<void>(resolve => { settle = resolve; });
    const deps = createDeps({ interruptedAdapterDrainTimeoutMs: 10, adapter: { async run() {
      started(); await eventuallySettled;
      return "finished";
    } } });
    vi.spyOn(deps.sandboxManager!, 'beginActivity').mockResolvedValue(true);
    const end = vi.spyOn(deps.sandboxManager!, 'finishActivity').mockResolvedValue();
    const session = await deps.sessionStore.create({ tenantId: 'tenant_1', agentId: sandboxedAgent.id, agent: sandboxedAgent, workspaceId: 'ws_1' });
    await enqueue(deps.pendingEventStore, session.id, 'work');
    const running = deps.router.handleNewEvent(session.id, sandboxedAgent);
    await ready; deps.router.interrupt(session.id); await running;
    expect(end).not.toHaveBeenCalled();
    expect((await deps.eventLogStore.getEvents(session.id)).data.map(event => event.type)).toContain('session.turn_completed');
    settle();
    await vi.waitFor(() => expect(end).toHaveBeenCalledOnce());
  });
  it.each(['complete', 'failure', 'Interrupt'] as const)('holds activity through model waiting and releases only after actual %s settlement', async outcome => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let finish!: () => void;
    const wait = new Promise<void>(resolve => { finish = resolve; });
    const deps = createDeps({ adapter: { async run(input) {
      started();
      if (outcome === 'Interrupt') await new Promise<void>(resolve => input.signal!.addEventListener('abort', () => resolve(), { once: true }));
      else await wait;
      if (outcome === 'failure') throw new Error('provider failed');
      return "finished";
    } } });
    const begin = vi.spyOn(deps.sandboxManager!, 'beginActivity').mockResolvedValue(true);
    const end = vi.spyOn(deps.sandboxManager!, 'finishActivity').mockResolvedValue();
    const session = await deps.sessionStore.create({ tenantId: 'tenant_1', agentId: sandboxedAgent.id, agent: sandboxedAgent, workspaceId: 'ws_1' });
    await enqueue(deps.pendingEventStore, session.id, 'think');
    const running = deps.router.handleNewEvent(session.id, sandboxedAgent);
    await ready;
    expect(begin).toHaveBeenCalledOnce();
    expect(end).not.toHaveBeenCalled();
    expect(deps.sandboxClient.created).toHaveLength(0);
    if (outcome === 'Interrupt') deps.router.interrupt(session.id); else finish();
    await running;
    expect(end).toHaveBeenCalledOnce();
    expect(end.mock.calls[0][0]).toMatchObject({ bindingId: session.id, sessionId: session.id });
  });
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
      async run(input: AdapterInput) {
        const write = journalWriter(input);
        sawExecutor = input.toolExecutor != null;
        await write({
          id: "e",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text: "ok" }],
        });
        return "finished";
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
      async run(input: AdapterInput) {
        const write = journalWriter(input);
        adapterInvoked = true;
        await write({
          id: "e",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text: "should not run" }],
        });
        return "finished";
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
      async run(input: AdapterInput) {
        const write = journalWriter(input);
        adapterInvoked = true;
        await write({
          id: "e",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text: "x" }],
        });
        return "finished";
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
  it("does not probe after a completed answer; verifies the next Turn and recovers without replay", async () => {
    const sandboxClient = new FakeSandboxClient();
    let adapterRuns = 0;
    const toolErrors: unknown[] = [];
    const adapter: Adapter = {
      async run(input) {
        const write = journalWriter(input);
        adapterRuns++;
        // A tool error, as Pi returns it to the model: the Turn goes on.
        await input.toolExecutor!.writeFile("saved.txt", `saved-${adapterRuns}`).catch((error: unknown) => { toolErrors.push(error); });
        if (adapterRuns === 1) sandboxClient.setMountFailure(sandboxClient.created[0], "storage offline");
        await write({
          id: `answer-${adapterRuns}`, timestamp: "2026-09-14T00:00:00.000Z", type: "agent.message",
          content: [{ type: "text", text: `answer-${adapterRuns}` }],
        });
        return "finished";
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
    expect(firstTurn.find((event) => event.type === "session.error")).toBeUndefined();
    expect(firstTurn.filter((event) => event.type === "session.turn_completed")).toHaveLength(1);
    expect(firstTurn.filter((event) => event.type === "workspace.file_change")).toHaveLength(0);
    expect((await collectEventTypes(sub))).toContain("session.status_idle");
    expect((await sessionStore.getById(session.id))?.status).toBe("idle");
    expect(await pendingEventStore.count(session.id)).toBe(0);
    expect(sandboxClient.workspaceContents("tenant_1/ws_1/").get("saved.txt")?.content).toBe("saved-1");
    await router.handleNewEvent(session.id, sandboxedAgent);
    expect(adapterRuns).toBe(1);

    // The next Turn runs: its tool fails with the Sandbox unavailability, and
    // the Turn, its Sandbox never ready again, ends with sandbox_unavailable.
    await enqueue(pendingEventStore, session.id, "cannot execute while unavailable");
    await router.handleNewEvent(session.id, sandboxedAgent);
    expect(adapterRuns).toBe(2);
    expect(toolErrors).toEqual([expect.objectContaining({ name: "SandboxUnavailable", code: "sandbox_unavailable", reason: "mount" })]);
    const errors = async () => (await eventLogStore.getEvents(session.id, { limit: 100 })).data.filter((event) => event.type === "session.error");
    expect((await errors()).map((event) => (event.data as { error: { code: string } }).error.code)).toEqual(["sandbox_unavailable"]);
    expect(sandboxClient.workspaceContents("tenant_1/ws_1/").get("saved.txt")?.content).toBe("saved-1");
    sandboxClient.setMountFailure(sandboxClient.created[0]);
    await enqueue(pendingEventStore, session.id, "retry after recovery");
    await router.handleNewEvent(session.id, sandboxedAgent);
    expect(adapterRuns).toBe(3);
    expect(toolErrors).toHaveLength(1);
    expect(await errors()).toHaveLength(1);
    expect(sandboxClient.created).toHaveLength(1);
    expect(sandboxClient.workspaceContents("tenant_1/ws_1/").get("saved.txt")?.content).toBe("saved-3");
    expect((await sessionStore.getById(session.id))?.status).toBe("idle");
  });

  it.each(["failure", "Interrupt"] as const)("retains closed files after an adapter %s and Session termination", async (outcome) => {
    let wrote!: () => void;
    const written = new Promise<void>((resolve) => { wrote = resolve; });
    const adapter: Adapter = {
      async run(input) {
        await input.toolExecutor!.writeFile("saved.txt", "closed before the Turn ended");
        wrote();
        if (outcome === "failure") throw new Error("adapter failed after saving");
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted) return resolve();
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return "finished";
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
      async run(input: AdapterInput) {
        const write = journalWriter(input);
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
        await write({
          id: "e",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text }],
        });
        return "finished";
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
      async run(input: AdapterInput) {
        const write = journalWriter(input);
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
        await write({
          id: "workspace-refresh",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text }],
        });
        return "finished";
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
    // Equip a Skill with a bundle, run a turn, and assert the session can
    // read it at /skills/<skill-name> — the Skill Install end to end (ADR-0022).
    const skillStore = new InMemorySkillStore();
    const skillBundleStore = new InMemorySkillBundleStore();
    const SKILL_BODY = "---\nname: greeter\n---\nsay hi";
    const skill = await createSkill(skillStore, skillBundleStore, {
      tenantId: "tenant_1",
      name: "greeter",
      description: "greets",
      ownerType: "agent",
      ownerId: "agent_sbx",
    }, { "SKILL.md": SKILL_BODY });

    let readBody = "<unread>";
    let descriptors: AdapterInput["agent"]["skillDescriptors"];
    const skillReadingAdapter: Adapter = {
      async run(input: AdapterInput) {
        const write = journalWriter(input);
        descriptors = input.agent.skillDescriptors;
        // The adapter is pointed at the in-sandbox /skills/<skill-name> root and reads
        // SKILL.md from there, exactly as Pi's sandbox-mapped read would.
        const root = input.agent.skillPaths?.[0];
        // Skills live outside /home/user/workspace, so read via an absolute-path
        // exec (cat) — the FakeSandboxClient's built-in cat reads any abs path.
        for await (const chunk of input.toolExecutor!.exec(["cat", `${root}/SKILL.md`])) {
          if (chunk.stream === "stdout") readBody = chunk.text;
        }
        await write({
          id: "e",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text: readBody }],
        });
        return "finished";
      },
    };

    const { router, sessionStore, pendingEventStore, sandboxClient } = createDeps({
      adapter: skillReadingAdapter,
      skillBundleStore,
      skillStore,
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

    // The Skill was installed at /skills/<skill-name>/SKILL.md, read-only, and
    // readable inside the sandbox with the bundle's content.
    const id = sandboxClient.created[0];
    expect(await sandboxClient.readFile(id, "/skills/greeter/SKILL.md")).toBe(SKILL_BODY);
    expect(sandboxClient.filesOf(id).get("/skills/greeter/SKILL.md")?.mode).toBe(0o444);
    expect(readBody).toBe(SKILL_BODY);

    // Edit the Skill while the Session stays alive. The next turn must install
    // the new version into the same sandbox and rebuild prompt metadata from the store.
    const UPDATED_BODY = "---\nname: greeter-v2\n---\nsay hello";
    await skillStore.update(skill.id, {
      name: "greeter-v2",
      description: "greets better",
      ...await withBundle(skillBundleStore, { "SKILL.md": UPDATED_BODY }),
    });

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
    const skillStore = new InMemorySkillStore();
    const skillBundleStore = new InMemorySkillBundleStore();
    const ids: string[] = [];
    const renamed = new Map<string, Skill>();
    for (const name of names) {
      // Renamed behind the store's back: the Skill store itself rejects these names.
      const skill = await createSkill(skillStore, skillBundleStore, { tenantId: "tenant_1", ownerType: "agent", ownerId: sandboxedAgent.id, name: `placeholder-${ids.length}`, description: name }, { "SKILL.md": "body" });
      renamed.set(skill.id, { ...skill, name });
      ids.push(skill.id);
    }
    vi.spyOn(skillStore, "getById").mockImplementation(async (id) => renamed.get(id) ?? null);
    let adapterRan = false;
    const adapter: Adapter = {
      async run() { adapterRan = true; return "finished"; },
    };
    const { router, sessionStore, pendingEventStore, eventLogStore, sandboxClient } = createDeps({ adapter, skillStore, skillBundleStore });
    const agent = { ...sandboxedAgent, skills: ids };
    const session = await sessionStore.create({ tenantId: "tenant_1", agentId: agent.id, agent, workspaceId: "ws_1" });
    await enqueue(pendingEventStore, session.id, "load equipped Skills");
    await router.handleNewEvent(session.id, agent);
    expect(adapterRan).toBe(false);
    expect(sandboxClient.created).toHaveLength(0);
    expect((await eventLogStore.getEvents(session.id, { limit: 100 })).data).toContainEqual(expect.objectContaining({
      type: "session.error", data: expect.objectContaining({ error: expect.objectContaining({ code: "skills_invalid",
        message: expect.stringMatching(names.length === 2 ? /duplicate name: same/ : /not one safe directory name/) }) }),
    }));
    expect((await sessionStore.getById(session.id))?.status).toBe("idle");
  });

  it("leaves the Turn of an Agent whose Skills could not be read to the claim's retry, not to skills_invalid", async () => {
    const skillStore = new InMemorySkillStore();
    vi.spyOn(skillStore, "getById").mockRejectedValue(new Error("database unavailable"));
    let adapterRan = false;
    const adapter: Adapter = { async run() { adapterRan = true; return "finished"; } };
    const { router, sessionStore, pendingEventStore, eventLogStore } = createDeps({ adapter, skillStore });
    const agent = { ...sandboxedAgent, skills: ["skill_1"] };
    const session = await sessionStore.create({ tenantId: "tenant_1", agentId: agent.id, agent, workspaceId: "ws_1" });
    await enqueue(pendingEventStore, session.id, "load equipped Skills");
    await expect(router.handleNewEvent(session.id, agent)).rejects.toThrow("database unavailable");
    expect(adapterRan).toBe(false);
    expect((await eventLogStore.getEvents(session.id, { limit: 100 })).data.filter((stored) => stored.type === "session.error")).toEqual([]);
    expect(await pendingEventStore.peek(session.id)).not.toBeNull();
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
    const skillStore = new InMemorySkillStore();
    const skillBundleStore = new InMemorySkillBundleStore();
    const skill = await createSkill(skillStore, skillBundleStore, {
      tenantId: "tenant_1",
      name: "late-skill",
      description: "equipped after session creation",
      ownerType: "agent",
      ownerId: liveAgent.id,
    }, { "SKILL.md": "late body" });

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
      async run(input: AdapterInput) {
        const write = journalWriter(input);
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
        await write({
          id: "live-agent-config",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "agent.message",
          content: [{ type: "text", text: body ?? "warm" }],
        });
        return "finished";
      },
    };
    const { router, sessionStore, pendingEventStore, sandboxClient } = createDeps({
      adapter,
      agentStore,
      skillBundleStore,
      skillStore,
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

describe('SessionRouter — recoverable Sandbox faults', () => {
  it('continues within one Turn after a paused tool failure without replaying its write', async () => {
    const sandboxClient = new FakeSandboxClient();
    const errors: string[] = [];
    let runs = 0;
    const adapter: Adapter = { async run(input) {
      const write = journalWriter(input);
      runs++;
      await input.toolExecutor!.writeFile('effect.txt', 'once');
      sandboxClient.pause(sandboxClient.created[0]);
      try { await input.toolExecutor!.writeFile('effect.txt', 'twice'); }
      catch (error) { errors.push(String(error)); }
      const saved = await input.toolExecutor!.readFile('effect.txt');
      await write({ id: 'continued', timestamp: new Date().toISOString(), type: 'agent.message', content: [{ type: 'text', text: saved }] });
      return "finished";
    } };
    const { router, sessionStore, pendingEventStore, eventLogStore } = createDeps({ adapter, sandboxClient });
    const session = await sessionStore.create({ tenantId: 'tenant_1', agentId: sandboxedAgent.id, agent: sandboxedAgent, workspaceId: 'ws_1' });
    await enqueue(pendingEventStore, session.id, 'continue after Sandbox recovery');
    await router.handleNewEvent(session.id, sandboxedAgent);
    expect(runs).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('not replayed');
    const events = (await eventLogStore.getEvents(session.id, { limit: 100 })).data;
    expect(events.filter(event => event.type === 'session.turn_completed')).toHaveLength(1);
    expect(events.filter(event => event.type === 'session.turn_aborted')).toHaveLength(0);
    expect(events.find(event => event.type === 'agent.message')?.data).toMatchObject({ content: [{ type: 'text', text: 'once' }] });
    expect(sandboxClient.created).toHaveLength(1);
  });
});
