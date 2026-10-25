import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createMemoryStores } from "@oma-server/store-memory";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { DefaultSandboxManager, DefaultTurnSandboxes, FakeSandboxClient, type SandboxManager } from "@oma-server/sandbox";
import type { SandboxActivity, StoredEvent } from "@oma-server/store";
import type { Adapter, AdapterInput, SessionEvent } from "@open-managed-agents/adapter-core";
import { journalWriter } from "@open-managed-agents/adapter-mock";
import { SessionRouter, type SessionRouterDeps } from "../src/session-router.js";
import { OUTCOME_UNKNOWN } from "../src/dangling-call-results.js";

/**
 * Graceful shutdown hands a Runner's running Turns to the other Runners
 * (#254, RECOVERY-MATRIX.md F). Routers share one durable store; a wake one
 * of them publishes reaches every live Router, as the Redis signal does.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean> | boolean, timeout = 4000) {
  const start = Date.now();
  while (!await check()) { if (Date.now() - start > timeout) throw new Error("Timed out"); await sleep(5); }
}
function gate<T = void>() {
  let open!: (value: T) => void;
  const opened = new Promise<T>((resolve) => { open = resolve; });
  return { open, opened };
}
const event = (type: string, data: object = {}) => ({ id: randomUUID(), timestamp: new Date().toISOString(), type, ...data }) as SessionEvent;
const dataOf = (stored: StoredEvent) => stored.data as Record<string, unknown>;

/** A tool call of a scripted Turn, as one Router executed it. */
interface Execution { router: string; sessionId: string; turnId: string; call: string }

/** What the scripted runtime does at each point of a Turn. */
interface Script {
  /** Tool calls per Turn before the answer. */
  steps?: number;
  /** A tool call's output; it may take as long as it likes. */
  tool?(execution: Execution, input: AdapterInput): Promise<string>;
  /** A model request in flight, once its gate has passed; `step` is the number of calls before it. */
  request?(request: { router: string; turnId: string; step: number }): Promise<void>;
}

/**
 * A scripted runtime whose Turn makes `steps` tool calls, one per model
 * request, then answers. A continued attempt picks up after the results the
 * Turn committed. A requested stop takes effect only at the model request
 * gate, as Pi's does: a running tool or request is never cancelled by it.
 */
function stepsAdapter(script: Script, tool: (execution: Execution, input: AdapterInput) => Promise<string>, router: () => string): Adapter {
  const steps = script.steps ?? 1;
  return {
    async run(input) {
      const write = journalWriter(input);
      const answered = input.history.filter((past) => past.type === "agent.tool_result" &&
        (past as unknown as { turnId?: string }).turnId === input.turnId).length;
      for (let step = answered; ; step++) {
        if (input.stopRequest?.aborted) return "stopped";
        await script.request?.({ router: router(), turnId: input.turnId, step });
        if (step === steps) {
          await write(event("agent.message", { content: [{ type: "text", text: "done" }] }));
          return "finished";
        }
        const call = `call_${step}`;
        await write(event("agent.tool_use", { toolUseId: call, name: "bash", input: { command: call } }));
        const output = await tool({ router: router(), sessionId: input.sessionId, turnId: input.turnId, call }, input);
        await write(event("agent.tool_result", { toolUseId: call, content: [{ type: "text", text: output }], isError: false }));
      }
    },
  };
}

async function harness(options: Script & { adapter?: Adapter } = {}) {
  const stores = createMemoryStores();
  // Delegation runs in a Sandbox; the other scenarios need none.
  const sandboxed = options.adapter !== undefined;
  const agent = await stores.agentStore.create({ tenantId: "tenant", name: "Test", model: "test", system: "test",
    runtime: "pi-agent", sandbox: { enabled: sandboxed } });
  const sandboxClient = new FakeSandboxClient();
  const workspace = await stores.workspaceStore.create({ tenantId: "tenant" });
  const createSession = () => stores.sessionStore.create({ tenantId: "tenant", agentId: agent.id, agent, workspaceId: workspace.id });
  const session = await createSession();
  const executions: Execution[] = [];
  const inputs: Array<{ router: string; input: AdapterInput }> = [];
  const errors: Array<{ router: string; error: unknown }> = [];
  const live = new Map<string, SessionRouter>();
  const lost = new Set<string>();
  // A lost Runner neither renews nor claims; its lease runs out.
  const renew = stores.pendingEventStore.renewClaim.bind(stores.pendingEventStore);
  stores.pendingEventStore.renewClaim = async (sessionId, eventId, claim, leaseMs) =>
    lost.has(claim.ownerId) ? { renewed: false, interruptRequested: false } : renew(sessionId, eventId, claim, leaseMs);
  const claim = stores.pendingEventStore.claim.bind(stores.pendingEventStore);
  /** Claims taken, and every claim tried, by owner. */
  const claims: string[] = [];
  const claimAttempts: string[] = [];
  stores.pendingEventStore.claim = async (sessionId, ownerId, leaseMs) => {
    if (lost.has(ownerId)) return null;
    claimAttempts.push(ownerId);
    const claimed = await claim(sessionId, ownerId, leaseMs);
    if (claimed) claims.push(ownerId);
    return claimed;
  };
  const tool = options.tool ?? (async () => "ok");
  /** One Runner's Turn Sandboxes over the shared stores. */
  const sandboxesOf = (name: string, manager: SandboxManager = new DefaultSandboxManager({ sandboxClient, environment: "test" })) => new DefaultTurnSandboxes({
    manager, bindings: stores.delegationStore, sessions: stores.sessionStore,
    workspaceMount: { bucket: "agentry", agentName: "agentry-workspace", pvName: "agentry-workspace-oss", credentialProviderName: "agentry-oss-rw" },
    onError: ({ error }) => errors.push({ router: name, error }),
  });
  const start = (name: string, deps: Partial<SessionRouterDeps> = {}) => {
    const adapter = options.adapter ?? stepsAdapter(options, async (execution, input) => {
      executions.push(execution);
      return tool(execution, input);
    }, () => name);
    const router = new SessionRouter({
      ...stores, eventStreamHub: new InProcessEventStreamHub(),
      resolveAdapter: () => ({ run: (input) => { inputs.push({ router: name, input }); return adapter.run(input); } }),
      pendingClaimOwnerId: name, pendingClaimLeaseMs: 200, pendingClaimRenewIntervalMs: 50,
      pendingClaimRetryMinMs: 10, pendingClaimRetryMaxMs: 20,
      ...(sandboxed ? { sandboxes: sandboxesOf(name) } : {}),
      // The Redis wake every Runner receives, this one included.
      wakeSession: (sessionId) => {
        for (const other of live.values()) void other.handleNewEvent(sessionId, agent).catch((error) => errors.push({ router: name, error }));
      },
      onDrainError: ({ error }) => errors.push({ router: name, error }),
      ...deps,
    });
    live.set(name, router);
    return router;
  };
  /** SIGTERM: the Router hands its Turns over within `graceMs`, then its process exits. */
  const shutDown = async (name: string, graceMs = 2000) => {
    const handedOff = await live.get(name)!.handOff(graceMs);
    live.delete(name);
    return handedOff;
  };
  /** kill -9: the Router stops renewing and claiming; its lease runs out. */
  const lose = (name: string) => { lost.add(name); live.delete(name); };
  const enqueue = (text: string, sessionId = session.id) => stores.pendingEventStore.enqueue(sessionId, {
    type: "user.message", data: { content: [{ type: "text", text }] }, sessionThreadId: "sthr_primary",
  });
  const log = async (sessionId = session.id) => (await stores.eventLogStore.getEvents(sessionId, { limit: 1000 })).data;
  const ofType = async (type: string, sessionId = session.id) => (await log(sessionId)).filter((stored) => stored.type === type);
  const idle = async (sessionId = session.id) => (await stores.sessionStore.getById(sessionId))?.status === "idle" &&
    await stores.pendingEventStore.count(sessionId) === 0;
  /** What failed on a Runner that was not lost. */
  const failures = () => errors.filter(({ router }) => !lost.has(router));
  return { stores, agent, session, createSession, executions, inputs, errors, failures, claims, claimAttempts, live, lost, sandboxesOf, start, shutDown, lose, enqueue, log, ofType, idle };
}

describe("a Runner that shuts down hands its running Turns to the other Runners", () => {
  it("F1 shut down while a tool runs: the result is committed, the Turn stops before the next request and the other Runner continues it without running the tool again", async () => {
    const toolRunning = gate();
    const toolDone = gate<string>();
    const h = await harness({ steps: 2, tool: async (execution) => {
      if (execution.call !== "call_0") return "second ok";
      toolRunning.open();
      return toolDone.opened;
    } });
    await h.enqueue("work");
    const a = h.start("runner-a");
    h.start("runner-b");
    void a.handleNewEvent(h.session.id, h.agent);
    await toolRunning.opened;

    const handingOff = h.shutDown("runner-a");
    // The tool is not cancelled: it finishes, and its result is committed first.
    toolDone.open("first ok");
    expect(await handingOff).toBe(true);
    await until(() => h.idle());

    const [turnId] = h.inputs.map(({ input }) => input.turnId);
    expect(h.inputs.map(({ router, input }) => [router, input.turnId])).toEqual([["runner-a", turnId], ["runner-b", turnId]]);
    // Each call ran once, on the Runner it was requested on, with its real result.
    expect(h.executions.map(({ router, call }) => [router, call])).toEqual([["runner-a", "call_0"], ["runner-b", "call_1"]]);
    expect((await h.ofType("agent.tool_result")).map((stored) => [dataOf(stored).toolUseId, dataOf(stored).isError]))
      .toEqual([["call_0", false], ["call_1", false]]);
    // The other Runner took the Turn over as handed over, not lost.
    expect((await h.ofType("session.turn_resumed")).map(dataOf))
      .toEqual([{ turnId, generation: 2, reason: "released", danglingToolUseIds: [] }]);
    expect(h.inputs[1].input.resume).toEqual({ completedModelSteps: 0, blockBase: 0 });
    expect((await h.ofType("session.turn_completed")).map((stored) => dataOf(stored).turnId)).toEqual([turnId]);
    expect(await h.ofType("session.error")).toEqual([]);
    expect(await h.ofType("session.turn_aborted")).toEqual([]);
    // Runner A claimed only the input it started with.
    expect(h.claims).toEqual(["runner-a", "runner-b"]);
    expect(h.errors).toEqual([]);
  });

  it("F2 a tool still running at the deadline is not cancelled: the Turn is detached, the other Runner continues it and that call's outcome is unknown", async () => {
    const toolRunning = gate();
    const late = gate<string>();
    let signalled: AbortSignal | undefined;
    const h = await harness({ steps: 2, tool: async (execution, input) => {
      if (execution.call !== "call_0") return "second ok";
      signalled = input.signal;
      toolRunning.open();
      return late.opened;
    } });
    await h.enqueue("work");
    const a = h.start("runner-a");
    h.start("runner-b");
    void a.handleNewEvent(h.session.id, h.agent);
    await toolRunning.opened;

    // The grace period runs out while the tool still runs.
    expect(await h.shutDown("runner-a", 30)).toBe(false);
    await until(() => h.idle());
    // The tool finishes after its Runner has gone: nothing it reports is written.
    late.open("late ok");
    await sleep(20);

    // Pi aborts as its Turn signal fires; the stopped attempt's executor refuses what Pi then sends.
    expect(signalled?.aborted).toBe(true);
    const [turnId] = h.inputs.map(({ input }) => input.turnId);
    expect(h.executions.map(({ router, call }) => [router, call])).toEqual([["runner-a", "call_0"], ["runner-b", "call_1"]]);
    const results = (await h.ofType("agent.tool_result")).map(dataOf);
    expect(results.map((data) => [data.toolUseId, data.isError])).toEqual([["call_0", true], ["call_1", false]]);
    expect(results[0].content).toEqual([{ type: "text", text: OUTCOME_UNKNOWN }]);
    expect((await h.ofType("session.turn_resumed")).map(dataOf))
      .toEqual([{ turnId, generation: 2, reason: "released", danglingToolUseIds: ["call_0"] }]);
    expect((await h.ofType("session.turn_completed")).map((stored) => dataOf(stored).turnId)).toEqual([turnId]);
    expect(await h.ofType("session.error")).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it("F5 an idle Runner that shuts down claims nothing more and leaves the head it meant to retry to the other Runners", async () => {
    const h = await harness();
    await h.enqueue("work");
    const a = h.start("runner-a");
    // A failed claim leaves Runner A a claim retry for the Session.
    const claim = h.stores.pendingEventStore.claim;
    h.stores.pendingEventStore.claim = async () => { h.stores.pendingEventStore.claim = claim; throw new Error("PG unavailable"); };
    await expect(a.handleNewEvent(h.session.id, h.agent)).rejects.toThrow("PG unavailable");
    h.start("runner-b");

    const started = Date.now();
    expect(await h.shutDown("runner-a", 10_000)).toBe(true);
    expect(Date.now() - started).toBeLessThan(100);
    // Neither a wake nor a pending scan makes it claim.
    await a.handleNewEvent(h.session.id, h.agent);
    await a.recoverPendingEvents();
    await until(() => h.idle());
    await sleep(50);

    expect(h.claims).toEqual(["runner-b"]);
    expect(h.inputs.map(({ router }) => router)).toEqual(["runner-b"]);
    expect(h.errors).toEqual([]);
  });

  it("G2 queued inputs behind a handed-over Turn run after it, in order, on the Runner that took it over", async () => {
    const toolRunning = gate();
    const toolDone = gate<string>();
    const h = await harness({ steps: 2, tool: async (execution) => {
      if (execution.router !== "runner-a") return "ok";
      toolRunning.open();
      return toolDone.opened;
    } });
    for (const text of ["first", "second", "third"]) await h.enqueue(text);
    const a = h.start("runner-a");
    h.start("runner-b");
    void a.handleNewEvent(h.session.id, h.agent);
    await toolRunning.opened;

    const handingOff = h.shutDown("runner-a");
    toolDone.open("first ok");
    expect(await handingOff).toBe(true);
    await until(() => h.idle());

    const promoted = (await h.ofType("user.message")).map((stored) => (dataOf(stored).content as Array<{ text: string }>)[0].text);
    expect(promoted).toEqual(["first", "second", "third"]);
    const turns = [...new Set(h.inputs.map(({ input }) => input.turnId))];
    expect((await h.ofType("session.turn_completed")).map((stored) => dataOf(stored).turnId)).toEqual(turns);
    expect(turns).toHaveLength(3);
    expect(h.inputs.map(({ router, input }) => [router, turns.indexOf(input.turnId)]))
      .toEqual([["runner-a", 0], ["runner-b", 0], ["runner-b", 1], ["runner-b", 2]]);
    expect(h.executions.filter(({ turnId }) => turnId === turns[0]).map(({ router, call }) => [router, call]))
      .toEqual([["runner-a", "call_0"], ["runner-b", "call_1"]]);
    expect(await h.ofType("session.error")).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it("F3 shut down while the model streams its answer: that request finishes and completes the Turn there, and the input queued behind it goes to the other Runner", async () => {
    const answering = gate();
    const answer = gate();
    const h = await harness({ steps: 0, request: async ({ router, step }) => {
      if (router !== "runner-a" || step !== 0) return;
      answering.open();
      await answer.opened;
    } });
    await h.enqueue("first");
    await h.enqueue("second");
    const a = h.start("runner-a");
    h.start("runner-b");
    void a.handleNewEvent(h.session.id, h.agent);
    await answering.opened;

    const handingOff = h.shutDown("runner-a");
    answer.open();
    expect(await handingOff).toBe(true);
    await until(() => h.idle());

    const [first, second] = (await h.ofType("session.turn_completed")).map((stored) => dataOf(stored).turnId);
    expect(h.inputs.map(({ router, input }) => [router, input.turnId])).toEqual([["runner-a", first], ["runner-b", second]]);
    // The second input is a new Turn, not a takeover.
    expect(await h.ofType("session.turn_resumed")).toEqual([]);
    expect(h.claims).toEqual(["runner-a", "runner-b"]);
    expect(h.errors).toEqual([]);
  });

  it("E8 the Runners woken for a handed-over Turn race for it: exactly one takes it and the others stay quiet", async () => {
    const toolRunning = gate();
    const toolDone = gate<string>();
    const h = await harness({ steps: 2, tool: async (execution) => {
      if (execution.router !== "runner-a") return "ok";
      toolRunning.open();
      return toolDone.opened;
    } });
    await h.enqueue("work");
    const a = h.start("runner-a");
    h.start("runner-b");
    h.start("runner-c");
    void a.handleNewEvent(h.session.id, h.agent);
    await toolRunning.opened;

    const handingOff = h.shutDown("runner-a");
    toolDone.open("ok");
    expect(await handingOff).toBe(true);
    await until(() => h.idle());
    // Long enough for several claim retries, if a loser kept retrying.
    await sleep(100);

    const taker = h.claims[1];
    expect(h.claims).toEqual(["runner-a", taker]);
    const loser = taker === "runner-b" ? "runner-c" : "runner-b";
    // The wake made it try once; a head another Runner holds is not retried.
    expect(h.claimAttempts.filter((owner) => owner === loser)).toEqual([loser]);
    expect((await h.ofType("session.turn_resumed")).map((stored) => dataOf(stored).reason)).toEqual(["released"]);
    expect(h.errors).toEqual([]);
  });

  it("F7 a handoff, then the new owner is lost: the third Runner continues the Turn, and the takeovers are marked released, then expired", async () => {
    const toolRunning = gate();
    const toolDone = gate<string>();
    const lostMidTool = gate();
    const h = await harness({ steps: 3, tool: async (execution) => {
      if (execution.router === "runner-a") { toolRunning.open(); return toolDone.opened; }
      if (execution.router === "runner-b") { lostMidTool.open(); return new Promise<string>(() => {}); }
      return "ok";
    } });
    await h.enqueue("work");
    const a = h.start("runner-a");
    h.start("runner-b");
    void a.handleNewEvent(h.session.id, h.agent);
    await toolRunning.opened;
    const handingOff = h.shutDown("runner-a");
    toolDone.open("ok");
    expect(await handingOff).toBe(true);

    // Runner B continues the Turn and is killed while its tool runs.
    await lostMidTool.opened;
    h.lose("runner-b");
    await sleep(250);
    const c = h.start("runner-c");
    await c.recoverPendingEvents();
    await until(() => h.idle());

    const [turnId] = h.inputs.map(({ input }) => input.turnId);
    expect(h.inputs.map(({ router, input }) => [router, input.turnId]))
      .toEqual([["runner-a", turnId], ["runner-b", turnId], ["runner-c", turnId]]);
    expect((await h.ofType("session.turn_resumed")).map(dataOf)).toEqual([
      { turnId, generation: 2, reason: "released", danglingToolUseIds: [] },
      { turnId, generation: 3, reason: "expired", danglingToolUseIds: ["call_1"] },
    ]);
    const results = (await h.ofType("agent.tool_result")).map(dataOf);
    expect(results.map((data) => [data.toolUseId, data.isError])).toEqual([["call_0", false], ["call_1", true], ["call_2", false]]);
    expect(h.executions.map(({ router, call }) => [router, call])).toEqual([["runner-a", "call_0"], ["runner-b", "call_1"], ["runner-c", "call_2"]]);
    expect((await h.ofType("session.turn_completed")).map((stored) => dataOf(stored).turnId)).toEqual([turnId]);
    expect((await h.ofType("session.error"))).toEqual([]);
    expect(h.failures()).toEqual([]);
  });

  it("F6 a rolling restart of every Runner, one after another, keeps every running Turn going to its end without a recovery error", async () => {
    const h = await harness({ steps: 6, tool: async () => { await sleep(15); return "ok"; } });
    const sessions = [h.session, await h.createSession(), await h.createSession()];
    for (const session of sessions) await h.enqueue("work", session.id);
    const first = h.start("runner-1");
    h.start("runner-2");
    h.start("runner-3");
    for (const session of sessions) void first.handleNewEvent(session.id, h.agent);
    await until(() => h.executions.length >= sessions.length);

    // RollingUpdate: replace each Runner in turn while the Turns run.
    const stoppedAt = new Map<string, number>();
    for (const name of ["runner-1", "runner-2", "runner-3"]) {
      stoppedAt.set(name, h.inputs.length);
      expect(await h.shutDown(name)).toBe(true);
      h.start(`${name}-new`);
      await sleep(30);
    }
    for (const session of sessions) await until(() => h.idle(session.id));

    for (const session of sessions) {
      const log = await h.log(session.id);
      const turns = [...new Set(h.inputs.filter(({ input }) => input.sessionId === session.id).map(({ input }) => input.turnId))];
      expect(turns, `one Turn in ${session.id}`).toHaveLength(1);
      expect(log.filter((stored) => stored.type === "session.turn_completed").map((stored) => dataOf(stored).turnId)).toEqual(turns);
      expect(log.filter((stored) => stored.type === "session.error")).toEqual([]);
      // Every call ran exactly once and has its real result.
      const calls = h.executions.filter(({ sessionId }) => sessionId === session.id).map(({ call }) => call);
      expect(calls).toEqual(["call_0", "call_1", "call_2", "call_3", "call_4", "call_5"]);
      expect(log.filter((stored) => stored.type === "agent.tool_result").map((stored) => dataOf(stored).isError)).toEqual(Array(6).fill(false));
      // The Turn moved at least once, every time by a handoff.
      const takeovers = log.filter((stored) => stored.type === "session.turn_resumed").map((stored) => dataOf(stored));
      expect(takeovers.length).toBeGreaterThanOrEqual(1);
      expect(takeovers.every((data) => data.reason === "released" && (data.danglingToolUseIds as string[]).length === 0)).toBe(true);
    }
    // No Runner started an attempt once its shutdown began, and none failed.
    for (const [name, at] of stoppedAt) expect(h.inputs.slice(at).filter(({ router }) => router === name)).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it("F2 a Turn detached at the deadline leaves its Sandbox activity to the next owner, so the exiting Runner writes nothing after handOff", async () => {
    const toolRunning = gate();
    const late = gate();
    let attempts = 0;
    const adapter: Adapter = {
      async run(input) {
        const write = journalWriter(input);
        if (attempts++ === 0) {
          await write(event("agent.tool_use", { toolUseId: "call_0", name: "bash", input: { command: "sleep" } }));
          toolRunning.open();
          // The command outlives the grace period, then the runtime settles.
          await late.opened;
          return "finished";
        }
        await write(event("agent.message", { content: [{ type: "text", text: "done" }] }));
        return "finished";
      },
    };
    const h = await harness({ adapter });
    // Sandbox activity is tracked: each attempt begins one and finishes it once its runtime settled.
    let exited = false;
    const writesAfterExit: string[] = [];
    class TrackedSandboxes extends DefaultSandboxManager {
      override async beginActivity() { return true; }
      override async finishActivity(activity: SandboxActivity) {
        // The exiting Runner's process has closed its PostgreSQL pool.
        if (exited && activity.fence.ownerId === "runner-a") {
          writesAfterExit.push(activity.sessionId);
          throw new Error("Cannot use a pool after calling end on the pool");
        }
      }
    }
    const sandboxes = () => new TrackedSandboxes({ sandboxClient: new FakeSandboxClient(), environment: "test" });
    await h.enqueue("work");
    const a = h.start("runner-a", { sandboxes: h.sandboxesOf("runner-a", sandboxes()) });
    h.start("runner-b", { sandboxes: h.sandboxesOf("runner-b", sandboxes()) });
    void a.handleNewEvent(h.session.id, h.agent);
    await toolRunning.opened;

    expect(await h.shutDown("runner-a", 30)).toBe(false);
    exited = true;
    late.open();
    await until(() => h.idle());
    await sleep(20);

    expect(writesAfterExit).toEqual([]);
    expect(h.errors).toEqual([]);
    expect((await h.ofType("session.turn_resumed")).map((stored) => dataOf(stored).reason)).toEqual(["released"]);
  });

  it("F4 shut down while a parent waits on a synchronous delegation: the wait is detached at the deadline and resumed by the other Runner with the child's real result", async () => {
    const childStarted = gate();
    const childAnswer = gate();
    const parents: Array<{ turnId: string; resumed: boolean }> = [];
    const adapter: Adapter = {
      async run(input) {
        const write = journalWriter(input);
        if (input.execution?.isChild) {
          childStarted.open();
          if (input.stopRequest?.aborted) return "stopped";
          await childAnswer.opened;
          await write(event("agent.message", { content: [{ type: "text", text: "child answer" }] }));
          return "finished";
        }
        parents.push({ turnId: input.turnId, resumed: input.resume !== undefined });
        if (input.resume) {
          await write(event("agent.message", { content: [{ type: "text", text: "parent answer" }] }));
          return "finished";
        }
        await input.execution?.onResolved?.({ model: "test", thinking: "low", thinkingSource: "agent" });
        await write(event("agent.tool_use", { toolUseId: "call_agent", name: "Agent", input: { prompt: "child" } }));
        const output = await input.subagents!.delegate({ prompt: "child", runInBackground: false }, { toolUseId: "call_agent" });
        await write(event("agent.tool_result", { toolUseId: "call_agent", content: [{ type: "text", text: JSON.stringify(output) }], isError: false }));
        await write(event("agent.message", { content: [{ type: "text", text: "parent answer" }] }));
        return "finished";
      },
    };
    const h = await harness({ adapter });
    await h.enqueue("delegate");
    // The child runs on Runner B; a Child execution that changes Runner is #252's.
    const b = h.start("runner-b");
    const a = h.start("runner-a", { wakeSession: (sessionId) => void b.handleNewEvent(sessionId, h.agent) });
    void a.handleNewEvent(h.session.id, h.agent);
    await childStarted.opened;
    const [execution] = await h.stores.delegationStore.list("tenant", h.session.id);

    // The child's Turn is in its model request and the parent waits on it.
    expect(await h.shutDown("runner-a", 30)).toBe(false);
    childAnswer.open();
    await until(() => h.idle());
    await until(() => h.idle(execution.childId));

    const turnId = parents[0].turnId;
    expect(parents).toEqual([{ turnId, resumed: false }, { turnId, resumed: true }]);
    // One child, whose real result the resumed wait delivered in the original Turn.
    expect(await h.stores.delegationStore.list("tenant", h.session.id)).toHaveLength(1);
    expect((await h.stores.delegationStore.getExecution("tenant", execution.id))?.status).toBe("completed");
    const results = (await h.ofType("agent.tool_result")).map(dataOf);
    expect(results).toEqual([expect.objectContaining({ toolUseId: "call_agent", isError: false, turnId })]);
    expect(JSON.stringify(results[0].content)).toContain("child answer");
    expect((await h.ofType("session.turn_resumed")).map(dataOf))
      .toEqual([{ turnId, generation: 2, reason: "released", danglingToolUseIds: ["call_agent"] }]);
    expect((await h.ofType("session.turn_completed")).map((stored) => dataOf(stored).turnId)).toEqual([turnId]);
    expect(await h.ofType("session.error")).toEqual([]);
    expect(await h.ofType("session.error", execution.childId)).toEqual([]);
    expect(h.errors).toEqual([]);
  });
});
