import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createMemoryStores } from "@oma-server/store-memory";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { DefaultSandboxManager, DefaultTurnSandboxes, FakeSandboxClient } from "@oma-server/sandbox";
import type { Adapter, AdapterInput, SessionEvent } from "@open-managed-agents/adapter-core";
import { journalWriter } from "@open-managed-agents/adapter-mock";
import { SessionRouter, type SessionRouterDeps } from "../src/session-router.js";

/**
 * Runner Capacity (#328, ADR-0026): a Runner claims a top-level Session's
 * input only while fewer than N Turns execute on it, always claims a Child
 * Session's, and fills a freed slot with the oldest top-level head it left
 * at once, not at the next pending scan.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean> | boolean, timeout = 4000) {
  const start = Date.now();
  while (!await check()) { if (Date.now() - start > timeout) throw new Error("Timed out"); await sleep(5); }
}
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}
const event = (type: string, data: object = {}) => ({ id: randomUUID(), timestamp: new Date().toISOString(), type, ...data }) as SessionEvent;
const answer = (input: AdapterInput, text = "done") => journalWriter(input)(event("agent.message", { content: [{ type: "text", text }] }));

async function harness(options: { sandboxed?: boolean } = {}) {
  const stores = createMemoryStores();
  const agent = await stores.agentStore.create({ tenantId: "tenant", name: "Test", model: "test", system: "test",
    runtime: "pi-agent", sandbox: { enabled: options.sandboxed === true } });
  const workspace = await stores.workspaceStore.create({ tenantId: "tenant" });
  const createSession = () => stores.sessionStore.create({ tenantId: "tenant", agentId: agent.id, agent, workspaceId: workspace.id });
  const errors: unknown[] = [];
  const scans: string[] = [];
  const routers = new Set<SessionRouter>();
  const start = (adapter: Adapter, deps: Partial<SessionRouterDeps> = {}) => {
    const router: SessionRouter = new SessionRouter({
      ...stores, eventStreamHub: new InProcessEventStreamHub(), resolveAdapter: () => adapter,
      pendingClaimOwnerId: "runner-a", pendingClaimRetryMinMs: 10, pendingClaimRetryMaxMs: 20,
      ...(options.sandboxed ? { sandboxes: new DefaultTurnSandboxes({
        manager: new DefaultSandboxManager({ sandboxClient: new FakeSandboxClient(), environment: "test" }),
        bindings: stores.delegationStore, sessions: stores.sessionStore,
        workspaceMount: { bucket: "agentry", agentName: "agentry-workspace", pvName: "agentry-workspace-oss", credentialProviderName: "agentry-oss-rw" },
        onError: ({ error }) => errors.push(error),
      }) } : {}),
      // The Redis wake every Runner receives, as RunnerDispatch delivers it.
      wakeSession: (sessionId) => {
        for (const other of routers) void stores.sessionStore.getById(sessionId).then((session) =>
          session && other.handleNewEvent(sessionId, session.agent, session)).catch((error) => errors.push(error));
      },
      onDrainError: ({ error }) => errors.push(error),
      ...deps,
    });
    const recover = router.recoverPendingEvents.bind(router);
    router.recoverPendingEvents = async (...args) => { scans.push("scan"); return recover(...args); };
    routers.add(router);
    return router;
  };
  const enqueue = (sessionId: string, text = "work") => stores.pendingEventStore.enqueue(sessionId, {
    type: "user.message", data: { content: [{ type: "text", text }] }, sessionThreadId: "sthr_primary",
  });
  const idle = async (sessionId: string) => (await stores.sessionStore.getById(sessionId))?.status === "idle" &&
    await stores.pendingEventStore.count(sessionId) === 0;
  return { stores, agent, createSession, start, enqueue, idle, errors, scans };
}

describe("Runner Capacity admits top-level Sessions below N (#328)", () => {
  it("N=3 and ten top-level Sessions at once: never more than three execute, and the rest run in the order they arrived, each as a slot frees, without a pending scan", async () => {
    const h = await harness();
    const sessions = [];
    for (let i = 0; i < 10; i++) sessions.push(await h.createSession());
    for (const session of sessions) await h.enqueue(session.id);
    const started: string[] = [];
    let executing = 0;
    let most = 0;
    const router = h.start({
      async run(input) {
        started.push(input.sessionId);
        most = Math.max(most, ++executing);
        await sleep(15);
        executing--;
        await answer(input);
        return "finished";
      },
    }, { capacity: 3 });

    // Their wakes arrive in another order than their input.
    const woken = [...sessions].reverse();
    for (const session of woken) void router.handleNewEvent(session.id, session.agent, session);
    for (const session of sessions) await until(() => h.idle(session.id));

    expect(most).toBe(3);
    // The three woken first ran at once; every other ran in arrival order.
    const first = woken.slice(0, 3).map((session) => session.id);
    expect(new Set(started.slice(0, 3))).toEqual(new Set(first));
    expect(started.slice(3)).toEqual(sessions.map((session) => session.id).filter((id) => !first.includes(id)));
    expect(router.capacityReport()).toEqual({ capacity: 3, executing: 0, syncWaiting: 0, free: 3 });
    expect(h.scans).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it("a full Runner ignores the wake of a top-level Session, and claims it the moment a slot frees, not at the next pending scan", async () => {
    const h = await harness();
    const [busy, waiting] = [await h.createSession(), await h.createSession()];
    const release = gate();
    const started: string[] = [];
    const claims: string[] = [];
    const claim = h.stores.pendingEventStore.claim.bind(h.stores.pendingEventStore);
    h.stores.pendingEventStore.claim = async (sessionId, owner, leaseMs) => { claims.push(sessionId); return claim(sessionId, owner, leaseMs); };
    const router = h.start({
      async run(input) {
        started.push(input.sessionId);
        if (input.sessionId === busy.id) await release.opened;
        await answer(input);
        return "finished";
      },
    }, { capacity: 1 });
    await h.enqueue(busy.id);
    void router.handleNewEvent(busy.id, h.agent, busy);
    await until(() => started.length === 1);
    await h.enqueue(waiting.id);
    await router.handleNewEvent(waiting.id, h.agent, waiting);
    await sleep(50);
    // Refused without a claim attempt, a read or a retry.
    expect(claims).toEqual([busy.id]);
    expect(started).toEqual([busy.id]);

    release.open();
    await until(() => h.idle(waiting.id));
    expect(started).toEqual([busy.id, waiting.id]);
    expect(h.scans).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it("a full Runner still claims and runs the Child Session its running parent waits on synchronously: no deadlock", async () => {
    const h = await harness({ sandboxed: true });
    const parent = await h.createSession();
    const other = await h.createSession();
    const ran: string[] = [];
    const router = h.start({
      async run(input) {
        const write = journalWriter(input);
        if (input.execution?.isChild) {
          ran.push("child");
          await write(event("agent.message", { content: [{ type: "text", text: "child answer" }] }));
          return "finished";
        }
        ran.push(input.sessionId === parent.id ? "parent" : "other");
        if (input.sessionId !== parent.id) { await answer(input); return "finished"; }
        await input.execution?.onResolved?.({ model: "test", thinking: "low", thinkingSource: "agent" });
        await write(event("agent.tool_use", { toolUseId: "call_agent", name: "Agent", input: { prompt: "child" } }));
        const output = await input.subagents!.delegate({ prompt: "child", runInBackground: false }, { toolUseId: "call_agent" });
        await write(event("agent.tool_result", { toolUseId: "call_agent", content: [{ type: "text", text: JSON.stringify(output) }], isError: false }));
        await answer(input, "parent answer");
        return "finished";
      },
    }, { capacity: 1 });
    await h.enqueue(parent.id, "delegate");
    void router.handleNewEvent(parent.id, h.agent, parent);
    await until(() => ran.includes("child"));
    // The parent holds the only slot while its child runs beyond it.
    await h.enqueue(other.id);
    void router.handleNewEvent(other.id, h.agent, other);
    await until(() => h.idle(parent.id));
    await until(() => h.idle(other.id));

    expect(ran).toEqual(["parent", "child", "other"]);
    const [execution] = await h.stores.delegationStore.list("tenant", parent.id);
    expect(execution.status).toBe("completed");
    expect(h.errors).toEqual([]);
  });

  it("a full Runner's pending scan claims the Child Sessions' heads behind a backlog of top-level heads, and none of the top-level ones", async () => {
    const h = await harness();
    const busy = await h.createSession();
    const release = gate();
    const started: string[] = [];
    const router = h.start({
      async run(input) {
        started.push(input.sessionId);
        if (input.sessionId === busy.id) await release.opened;
        await answer(input);
        return "finished";
      },
    }, { capacity: 1 });
    await h.enqueue(busy.id);
    void router.handleNewEvent(busy.id, h.agent, busy);
    await until(() => started.length === 1);
    const backlog = [];
    for (let i = 0; i < 5; i++) { backlog.push(await h.createSession()); await h.enqueue(backlog[i].id); }
    // A Child Session queued behind them, whose wake was lost.
    const child = await h.stores.sessionStore.create({ tenantId: "tenant", agentId: h.agent.id, agent: h.agent, workspaceId: busy.workspaceId,
      delegation: { parentSessionId: busy.id, parentTurnId: "turn", parentToolUseId: "call", sandboxSessionId: busy.id } });
    await h.enqueue(child.id);

    await router.recoverPendingEvents();
    await until(() => h.idle(child.id));
    expect(started).toEqual([busy.id, child.id]);
    release.open();
    for (const session of backlog) await until(() => h.idle(session.id));
    expect(started.slice(2)).toEqual(backlog.map((session) => session.id));
    expect(h.errors).toEqual([]);
  });

  it("N=1: a parent that only waits on its child frees its slot for another top-level Session, and continues beyond N once its wait ends (#330)", async () => {
    const h = await harness({ sandboxed: true });
    const parent = await h.createSession();
    const other = await h.createSession();
    const delegateNow = gate();
    const childAnswer = gate();
    const otherDone = gate();
    const ran: string[] = [];
    let resumedAt: ReturnType<SessionRouter["capacityReport"]> | undefined;
    let a!: SessionRouter;
    const adapter: Adapter = {
      async run(input) {
        const write = journalWriter(input);
        if (input.execution?.isChild) {
          ran.push("child");
          await childAnswer.opened;
          await answer(input, "child answer");
          return "finished";
        }
        if (input.sessionId === other.id) {
          ran.push("other");
          await otherDone.opened;
          await answer(input);
          return "finished";
        }
        ran.push("parent");
        await delegateNow.opened;
        await input.execution?.onResolved?.({ model: "test", thinking: "low", thinkingSource: "agent" });
        await write(event("agent.tool_use", { toolUseId: "call_agent", name: "Agent", input: { prompt: "child" } }));
        const output = await input.subagents!.delegate({ prompt: "child", runInBackground: false }, { toolUseId: "call_agent" });
        await write(event("agent.tool_result", { toolUseId: "call_agent", content: [{ type: "text", text: JSON.stringify(output) }], isError: false }));
        resumedAt = a.capacityReport();
        await answer(input, "parent answer");
        return "finished";
      },
    };
    // The child runs on another Runner, so this one's only Turns are the two top-level ones.
    const b = h.start(adapter, { pendingClaimOwnerId: "runner-b", wakeSession: () => {} });
    a = h.start(adapter, { capacity: 1, wakeSession: (sessionId) => void h.stores.sessionStore.getById(sessionId)
      .then((session) => session && b.handleNewEvent(sessionId, session.agent, session)) });
    await h.enqueue(parent.id, "delegate");
    void a.handleNewEvent(parent.id, h.agent, parent);
    await until(() => ran.includes("parent"));
    // Full: the other Session is refused while the parent runs.
    await h.enqueue(other.id);
    await a.handleNewEvent(other.id, h.agent, other);
    expect(ran).toEqual(["parent"]);

    delegateNow.open();
    await until(() => ran.includes("other") && ran.includes("child"));
    expect(a.capacityReport()).toEqual({ capacity: 1, executing: 1, syncWaiting: 1, free: 0 });

    childAnswer.open();
    await until(() => h.idle(parent.id));
    // The parent continued while the other Session still ran: two executing beyond N=1.
    expect(resumedAt).toEqual({ capacity: 1, executing: 2, syncWaiting: 0, free: 0 });
    otherDone.open();
    await until(() => h.idle(other.id));
    expect(a.capacityReport()).toEqual({ capacity: 1, executing: 0, syncWaiting: 0, free: 1 });
    expect(h.scans).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it("N defaults to 50 and must be a positive integer", async () => {
    const h = await harness();
    const adapter: Adapter = { async run() { return "finished"; } };
    expect(h.start(adapter).capacityReport()).toEqual({ capacity: 50, executing: 0, syncWaiting: 0, free: 50 });
    for (const capacity of [0, -1, 1.5, Number.NaN]) expect(() => h.start(adapter, { capacity })).toThrow(RangeError);
  });
});
