import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createMemoryStores } from "@oma-server/store-memory";
import { DefaultSandboxManager, DefaultTurnSandboxes, FakeSandboxClient, fakeEnvironments } from "@oma-server/sandbox";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import type { Adapter, AdapterInput, DurableEvent, SessionEvent, TurnJournalPort } from "@open-managed-agents/adapter-core";
import { journalWriter } from "@open-managed-agents/adapter-mock";
import { SessionRouter, type SessionRouterDeps } from "../src/session-router.js";
import { DelegationCoordinator } from "../src/delegation-coordinator.js";
import type { TurnJournal } from "../src/turn-journal.js";
import { PendingEventClaimLostError, presentEvent } from "@oma-server/store";
import { acceptInterrupt } from "./accept-interrupt.js";

const event = (type: string, data: object = {}) => ({ id: randomUUID(), timestamp: new Date().toISOString(), type, ...data }) as SessionEvent;
const text = (message: string) => event("agent.message", { content: [{ type: "text", text: message }], stopReason: "stop" });
const tool = (id: string) => event("agent.tool_use", { toolUseId: id, name: "Agent", input: { prompt: "child" } });
const result = (id: string, data: unknown) => event("agent.tool_result", { toolUseId: id, content: [{ type: "text", text: JSON.stringify(data) }], isError: false });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>, timeout = 4000) {
  const start = Date.now();
  while (!await check()) { if (Date.now() - start > timeout) throw new Error("Timed out"); await sleep(10); }
}
function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }

async function harness(adapter: Adapter, options: { quota?: number; leaseMs?: number } = {}) {
  const stores = createMemoryStores();
  const sandbox = new FakeSandboxClient();
  const agent = await stores.agentStore.create({ tenantId: "tenant", name: "Test", model: "test", system: "test", runtime: "pi-agent", sandbox: { enabled: true }, environmentId: "env_test" });
  const workspace = await stores.workspaceStore.create({ tenantId: "tenant" });
  const parent = await stores.sessionStore.create({ tenantId: "tenant", agentId: agent.id, agent, workspaceId: workspace.id });
  const errors: unknown[] = [];
  const hubs: InProcessEventStreamHub[] = [];
  const createHub = () => { const hub = new InProcessEventStreamHub(); hubs.push(hub); return hub; };
  const makeRouter = (deps: Partial<SessionRouterDeps> = {}) => new SessionRouter({
    ...stores, eventStreamHub: createHub(), resolveAdapter: () => adapter,
    sandboxes: new DefaultTurnSandboxes({ environments: fakeEnvironments(), manager: new DefaultSandboxManager({ sandboxClient: sandbox, environment: "test" }),
      bindings: stores.delegationStore, sessions: stores.sessionStore,
      workspaceMount: { bucket: "agentry", agentName: "agentry-workspace", pvName: "agentry-workspace-oss", credentialProviderName: "agentry-oss-rw" },
      onError: ({ error }) => errors.push(error) }),
    maxConcurrentSubagents: options.quota,
    pendingClaimLeaseMs: options.leaseMs ?? 30000,
    pendingClaimRenewIntervalMs: options.leaseMs ? Math.floor(options.leaseMs / 3) : 1000,
    pendingClaimRetryMinMs: 10, pendingClaimRetryMaxMs: 20,
    onDrainError: ({ error }) => errors.push(error),
    ...deps,
  });
  const router = makeRouter();
  const enqueue = async (message = "start") => stores.pendingEventStore.enqueue(parent.id, {
    type: "user.message", data: { content: [{ type: "text", text: message }] }, sessionThreadId: "sthr_primary",
  });
  const log = async (id = parent.id) => (await stores.eventLogStore.getEvents(id, { limit: 1000 })).data;
  return { stores, sandbox, agent, parent, router, makeRouter, enqueue, log, errors, hub: hubs[0] };
}

describe("Host-owned delegation through the Session Router", () => {
  it("persists native blocks once with the blockIndex of their deltas and restores native-only history", async () => {
    let runs = 0; let history: SessionEvent[] = [];
    // The Adapter numbers each bundled completion like the Deltas it replaces.
    const native = event("agent.context_entry", { sdk: "pi@0.83.0", entry: { id: "assistant1", type: "message", parentId: null, message: { role: "assistant", content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] } },
      presentation: { version: 1, blocks: [{ type: "agent.message", index: 0, blockIndex: 0 }, { type: "agent.message", index: 1, blockIndex: 1 }] } });
    const h = await harness({ async run(input) {
      const write = journalWriter(input);
      if (++runs > 1) { history = input.history; return "finished"; }
      await write(event("agent.message_stream_start")); await write(event("agent.message_chunk", { text: "first" })); await write(event("agent.message_stream_end"));
      await write(event("agent.message_stream_start")); await write(event("agent.message_chunk", { text: "second" })); await write(event("agent.message_stream_end"));
      await write(native);
      return "finished";
    } });
    await h.enqueue(); await h.router.handleNewEvent(h.parent.id, h.agent);
    const log = await h.log();
    expect(log.filter(e => e.type === "agent.context_entry")).toHaveLength(1);
    expect(log.filter(e => e.type === "agent.message")).toHaveLength(0);
    const displays = log.flatMap(e => presentEvent(e)).filter(e => e.type === "agent.message");
    expect(displays.map(e => (e.data as { blockIndex: number }).blockIndex)).toEqual([0, 1]);
    await h.enqueue("next"); await h.router.handleNewEvent(h.parent.id, h.agent);
    expect(history.filter(e => e.type === "agent.context_entry")).toHaveLength(1);
    expect(history.filter(e => e.type === "agent.message")).toHaveLength(0);
    expect(h.errors).toEqual([]);
  });

  it("consumes synchronous native tool results atomically and derives child output without display rows", async () => {
    const native = (id: string, message: object, blocks: object[]) => event("agent.context_entry", { sdk: "pi@0.83.0", entry: { id, parentId: null, type: "message", message }, presentation: { version: 1, blocks } });
    const h = await harness({ async run(input) {
      const write = journalWriter(input);
      if (input.execution?.isChild) {
        await write(native("child-answer", { role: "assistant", content: [{ type: "text", text: "native child answer" }], stopReason: "stop" }, [{ type: "agent.message", index: 0 }])); return "finished";
      }
      const call = native("parent-call", { role: "assistant", content: [{ type: "toolCall", id: "native-wait", name: "Agent", arguments: { prompt: "child" } }] }, [{ type: "agent.tool_use", index: 0 }]);
      await write(call);
      const output = await input.subagents!.delegate({ prompt: "child", runInBackground: false }, { toolUseId: "native-wait" });
      const result = native("parent-result", { role: "toolResult", toolCallId: "native-wait", toolName: "Agent", content: [{ type: "text", text: JSON.stringify(output) }], isError: false }, [{ type: "agent.tool_result" }]);
      await write(result);
      return "finished";
    } });
    await h.enqueue(); await h.router.handleNewEvent(h.parent.id, h.agent);
    const log = await h.log();
    expect(log.filter(e => e.type === "agent.tool_result" || e.type === "agent.tool_use")).toHaveLength(0);
    const results = log.flatMap(e => presentEvent(e)).filter(e => e.type === "agent.tool_result");
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results[0].data)).toContain("native child answer");
    const executions = await h.stores.delegationStore.listExecutions("tenant", { callerSessionId: h.parent.id, limit: 10 });
    expect(executions[0].consumedAt).toBeTruthy();
    expect((await h.log(executions[0].childId)).filter(e => e.type === "agent.message")).toHaveLength(0);
    expect(h.errors).toEqual([]);
  });

  it("keeps the Adapter's blockIndex when a native commit overtakes its deltas", async () => {
    const native = event("agent.context_entry", { sdk: "pi@0.83.0", entry: { id: "ahead", type: "message", parentId: null, message: { role: "assistant", content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] } },
      presentation: { version: 1, blocks: [{ type: "agent.message", index: 0, blockIndex: 0 }, { type: "agent.message", index: 1, blockIndex: 1 }] } });
    const h = await harness({ async run(input) {
      const write = journalWriter(input);
      // Pi's awaited compaction hook can commit before the Deltas of its blocks go out.
      await write(native);
      await write(event("agent.message_stream_start")); await write(event("agent.message_chunk", { text: "first" })); await write(event("agent.message_stream_end"));
      await write(event("agent.message_stream_start")); await write(event("agent.message_chunk", { text: "second" })); await write(event("agent.message_stream_end"));
      return "finished";
    } });
    await h.enqueue(); await h.router.handleNewEvent(h.parent.id, h.agent);
    const log = await h.log();
    expect(log.filter(e => e.type === "agent.context_entry")).toHaveLength(1);
    const displays = log.flatMap(e => presentEvent(e)).filter(e => e.type === "agent.message");
    expect(displays.map(e => (e.data as { blockIndex: number }).blockIndex)).toEqual([0, 1]);
    expect(h.errors).toEqual([]);
  });

  it("commits runtime context before continuation, deduplicates delivery and fences late writes", async () => {
    const usage = event("agent.context_usage", { turnId: "first", model: "test", tokens: 900, contextWindow: 1000, source: "sdk" });
    const context = event("agent.context_entry", { sdk: "pi@0.83.0", turnId: "first", entry: { type: "compaction", id: "durable", summary: "saved" } });
    let journal: TurnJournalPort | undefined;
    let runs = 0;
    let nextHistory: SessionEvent[] = [];
    const h = await harness({ async run(input) {
      const write = journalWriter(input);
      if (++runs === 1) {
        journal = input.journal;
        await write(usage);
        await write(context);
        // A second delivery of the same events writes nothing.
        await write(usage);
        await write(context);
      } else nextHistory = input.history;
      await write(text("completed after context commit"));
      return "finished";
    } });
    const published = vi.spyOn(h.hub, "publish");
    await h.enqueue(); await h.router.handleNewEvent(h.parent.id, h.agent);
    expect((await h.log()).filter(e => e.type === "agent.context_entry")).toHaveLength(1);
    expect((await h.log()).filter(e => e.type === "agent.context_usage" || e.type === "agent.context_entry").map(e => e.type)).toEqual(["agent.context_usage", "agent.context_entry"]);
    expect(published.mock.calls.some(([, e]) => e.type === "agent.context_entry")).toBe(true);
    await h.enqueue("next Turn"); await h.router.handleNewEvent(h.parent.id, h.agent);
    expect(nextHistory.filter(e => e.type === "agent.context_entry")).toHaveLength(1);
    expect(nextHistory.filter(e => e.type === "agent.context_usage")).toHaveLength(1);
    journal!.record({ ...context, id: "late-write" } as DurableEvent);
    await expect(journal!.flush()).rejects.toThrow();
    expect((await h.log()).filter(e => e.type === "agent.context_entry")).toHaveLength(1);
    expect(h.errors).toEqual([]);
  });

  it.each([false, true])("publishes result arrival before the parent finishes (background=%s)", async (runInBackground) => {
    const parentGate = gate();
    let parentTurns = 0;
    const h = await harness({ async run(input) {
      const write = journalWriter(input);
      if (input.execution?.isChild) { await write(text("child result")); return "finished"; }
      if (++parentTurns > 1) { await write(text("notification handled")); return "finished"; }
      const call = tool("live-result"); await write(call);
      const output = await input.subagents!.delegate({ prompt: "child", runInBackground }, { toolUseId: "live-result" });
      await write(result("live-result", output));
      await parentGate.promise;
      await write(text("parent done"));
      return "finished";
    } });
    const published = vi.spyOn(h.hub, "publish");
    await h.enqueue();
    const running = h.router.handleNewEvent(h.parent.id, h.agent);
    try {
      await until(async () => published.mock.calls.some(([id, event]) => id === h.parent.id && event.type === "subagent.result"));
      const log = await h.log();
      const notifications = published.mock.calls.filter(([id, event]) => id === h.parent.id && event.type === "subagent.result");
      expect(notifications).toHaveLength(1);
      const durable = log.find(event => event.type === "subagent.result")!;
      expect(notifications[0][1]).toEqual({ type: durable.type, seq: durable.seq, data: durable.data });
      expect(log.some(event => event.type === "subagent.result_claimed" || event.type === "session.turn_completed")).toBe(false);
    } finally {
      parentGate.release();
      await running;
    }
    expect(h.errors).toEqual([]);
  });

  it("pins create and resume to the calling parent's resolved provider/model despite Agent changes", async () => {
    let parentTurns = 0;
    let childId: string | undefined;
    const childModels: string[] = [];
    const actualModels = ["openai-codex/gpt-5.6-sol", "anthropic/claude-sonnet-4-5"];
    const h = await harness({ async run(input) {
      const write = journalWriter(input);
      if (input.execution?.isChild) {
        childModels.push(input.agent.model!);
        await input.execution.onResolved?.({ model: input.agent.model!, thinking: "high", thinkingSource: "model_default" });
        await write(text("child done")); return "finished";
      }
      const actualModel = actualModels[parentTurns++];
      await input.execution?.onResolved?.({ model: actualModel, thinking: "high", thinkingSource: "model_default" });
      // Another request edits the Agent after this parent Turn has resolved its model.
      await h.stores.agentStore.update(h.agent.id, { model: "unrelated/new-configuration" });
      const toolId = `delegate-${parentTurns}`;
      const call = tool(toolId); await write(call);
      const output = await input.subagents!.delegate({ prompt: "child", resume: childId, runInBackground: false }, { toolUseId: toolId }) as { childId: string };
      childId = output.childId;
      await write(result(toolId, output));
      return "finished";
    } });
    for (let turn = 0; turn < 2; turn++) {
      await h.enqueue(); await h.router.handleNewEvent(h.parent.id, h.agent);
    }
    expect(childModels).toEqual(actualModels);
    const executions = (await h.stores.delegationStore.list("tenant", h.parent.id)).sort((a, b) => a.sequence - b.sequence);
    expect(executions).toHaveLength(2);
    expect(executions.map(execution => execution.childId)).toEqual([childId, childId]);
    expect(executions.map(execution => execution.model)).toEqual(actualModels);
    expect(executions.map(execution => execution.effectiveConfig)).toEqual(actualModels.map(model => expect.objectContaining({ model, modelSource: "parent" })));
    expect(h.errors).toEqual([]);
  });

  it("keeps child capabilities restricted for direct user input after its delegated Turn", async () => {
    const inputs: AdapterInput[] = [];
    let childId = "";
    const h = await harness({ async run(input) {
      const write = journalWriter(input);
      inputs.push(input);
      if (input.sessionId === childId || input.execution?.isChild) { await write(text("child done")); return "finished"; }
      const call = tool("create-child"); await write(call);
      const output = await input.subagents!.delegate({ prompt: "child", runInBackground: false }, { toolUseId: "create-child" }) as { childId: string };
      childId = output.childId; await write(result("create-child", output));
      return "finished";
    } });
    await h.enqueue(); await h.router.handleNewEvent(h.parent.id, h.agent);
    const child = (await h.stores.sessionStore.getById(childId))!;
    const coordinator = new DelegationCoordinator({ store: h.stores.delegationStore,
      pending: h.stores.pendingEventStore, sessions: h.stores.sessionStore,
      wake() {}, check() {}, maxSteps: 30 });
    expect(() => coordinator.capability({ session: child, turnId: "direct-child-turn",
      fence: { eventId: "not-issued", ownerId: "host", generation: 1 }, signal: new AbortController().signal, journal: {} as TurnJournal,
    })).toThrow("Child Sessions cannot receive delegation capabilities");
    await h.stores.pendingEventStore.enqueue(childId, { type: "user.message", data: { content: [{ type: "text", text: "try delegating again" }] }, sessionThreadId: "sthr_primary" });
    await h.makeRouter().handleNewEvent(childId, child.agent);
    const childInputs = inputs.filter(input => input.sessionId === childId);
    expect(childInputs).toHaveLength(2);
    for (const input of childInputs) {
      expect(input.subagents).toBeUndefined();
      expect(input.execution).toMatchObject({ isChild: true, maxModelSteps: 500 });
      expect(input.agent.mcpServers).toBeUndefined();
      expect(input.toolExecutor).toBeDefined();
    }
    expect(h.errors).toEqual([]);
  });

  it("accepts an Interrupt on another Host and stops synchronous children while preserving queued parent input", async () => {
    let childStarted = false;
    let parentTurns = 0;
    const h = await harness({ async run(input) {
      const write = journalWriter(input);
      if (input.execution?.isChild) {
        childStarted = true;
        await new Promise<void>((resolve) => input.signal!.addEventListener("abort", () => resolve(), { once: true }));
        return "finished";
      }
      if (++parentTurns > 1) { await write(text("queued input processed")); return "finished"; }
      const call = tool("interrupt-sync"); await write(call);
      const done = await input.subagents!.delegate({ prompt: "child", runInBackground: false }, { toolUseId: "interrupt-sync" });
      await write(result("interrupt-sync", done));
      return "finished";
    } }, { leaseMs: 150 });
    await h.enqueue(); const running = h.router.handleNewEvent(h.parent.id, h.agent);
    await until(async () => childStarted && (await h.stores.sessionStore.getById(h.parent.id))?.status === "waiting");
    await h.enqueue("later input");
    // Accepted on a Host that runs nothing; the owner reads it on its next renewal.
    expect(await acceptInterrupt(h.stores.pendingEventStore, h.parent.id)).toBe(true);
    await running;
    expect(await h.router.waitForIdle(4000)).toBe(true);
    const executions = await h.stores.delegationStore.list("tenant", h.parent.id);
    expect(executions[0].status).toBe("interrupted");
    expect((await h.log()).filter((e) => e.type === "session.turn_aborted")).toHaveLength(1);
    expect(parentTurns).toBe(2);
    expect(h.errors).toEqual([]);
  });

  it("stops a synchronous child at once when its parent's Interrupt is hinted, not at the child's next renewal", async () => {
    let childStarted = false; let childAbortedAt = 0;
    const h = await harness({ async run(input) {
      const write = journalWriter(input);
      if (input.execution?.isChild) {
        childStarted = true;
        await new Promise<void>((resolve) => input.signal!.addEventListener("abort", () => { childAbortedAt = Date.now(); resolve(); }, { once: true }));
        return "finished";
      }
      const call = tool("hinted-interrupt"); await write(call);
      const done = await input.subagents!.delegate({ prompt: "child", runInBackground: false }, { toolUseId: "hinted-interrupt" });
      await write(result("hinted-interrupt", done));
      return "finished";
    } }, { leaseMs: 30_000 }); // Renews every 10 s: only the hint can stop the child sooner.
    await h.enqueue(); const running = h.router.handleNewEvent(h.parent.id, h.agent);
    await until(async () => childStarted && (await h.stores.sessionStore.getById(h.parent.id))?.status === "waiting");
    const requestedAt = Date.now();
    expect(await acceptInterrupt(h.stores.pendingEventStore, h.parent.id, h.router)).toBe(true);
    await until(async () => childAbortedAt > 0);
    expect(childAbortedAt - requestedAt).toBeLessThan(500);
    await running;
    expect(await h.router.waitForIdle(4000)).toBe(true);
    expect((await h.stores.delegationStore.list("tenant", h.parent.id))[0].status).toBe("interrupted");
    expect(h.errors).toEqual([]);
  });

  it("stops a synchronous child at once when its parent Session is terminated", async () => {
    let childStarted = false; let childAbortedAt = 0;
    const h = await harness({ async run(input) {
      const write = journalWriter(input);
      if (input.execution?.isChild) {
        childStarted = true;
        await new Promise<void>((resolve) => input.signal!.addEventListener("abort", () => { childAbortedAt = Date.now(); resolve(); }, { once: true }));
        return "finished";
      }
      const call = tool("terminated-parent"); await write(call);
      await input.subagents!.delegate({ prompt: "child", runInBackground: false }, { toolUseId: "terminated-parent" });
      return "finished";
    } }, { leaseMs: 30_000 });
    await h.enqueue(); void h.router.handleNewEvent(h.parent.id, h.agent);
    await until(async () => childStarted && (await h.stores.sessionStore.getById(h.parent.id))?.status === "waiting");
    const terminatedAt = Date.now();
    await h.stores.sessionStore.terminate(h.parent.id);
    await h.router.terminateSession(h.parent.id);
    await until(async () => childAbortedAt > 0);
    expect(childAbortedAt - terminatedAt).toBeLessThan(500);
    expect(await h.router.waitForIdle(4000)).toBe(true);
  });

  describe("a synchronous wait", () => {
    function waitingParent() {
      const childGate = gate(); let resultAt = 0;
      const adapter: Adapter = { async run(input) {
        const write = journalWriter(input);
        if (input.execution?.isChild) { await childGate.promise; await write(text("child answer")); return "finished"; }
        const call = tool("waited"); await write(call);
        const done = await input.subagents!.delegate({ prompt: "child", runInBackground: false }, { toolUseId: "waited" });
        resultAt = Date.now();
        await write(result("waited", done));
        return "finished";
      } };
      return { adapter, childGate, resultAt: () => resultAt };
    }

    it("receives the result as soon as the child completes on another Runner, without polling or waking it meanwhile", async () => {
      const turn = waitingParent();
      const h = await harness(turn.adapter);
      // Redis delivers a check hint to every Runner; the child's wake reaches the other Runner.
      const runners: SessionRouter[] = [];
      const checkSession = (sessionId: string) => { for (const runner of runners) runner.checkNow(sessionId); };
      const childRunner = h.makeRouter({ checkSession, wakeSession: () => {} });
      let childWakes = 0;
      const parentRunner = h.makeRouter({ checkSession, wakeSession: (sessionId) => {
        childWakes++;
        void h.stores.sessionStore.getById(sessionId).then((child) => childRunner.handleNewEvent(sessionId, child!.agent));
      } });
      runners.push(childRunner, parentRunner);
      const reads = vi.spyOn(h.stores.delegationStore, "get");

      await h.enqueue(); const running = parentRunner.handleNewEvent(h.parent.id, h.agent);
      await until(async () => (await h.stores.sessionStore.getById(h.parent.id))?.status === "waiting");
      const readsBefore = reads.mock.calls.length;
      await sleep(1_000);
      // The child was woken once, at acceptance; the wait reads the execution
      // only on its fallback poll (none yet), not five times a second.
      expect(childWakes).toBe(1);
      expect(reads.mock.calls.length - readsBefore).toBe(0);

      const releasedAt = Date.now();
      turn.childGate.release();
      await running;
      expect(turn.resultAt() - releasedAt).toBeLessThan(100);
      expect((await h.log()).filter((e) => e.type === "session.turn_completed")).toHaveLength(1);
      expect(h.errors).toEqual([]);
    });

    it("still receives the result through its fallback poll when the hint is lost", async () => {
      const turn = waitingParent();
      const h = await harness(turn.adapter);
      const router = h.makeRouter({ checkSession: () => {} });
      await h.enqueue(); const running = router.handleNewEvent(h.parent.id, h.agent);
      await until(async () => (await h.stores.sessionStore.getById(h.parent.id))?.status === "waiting");

      const releasedAt = Date.now();
      turn.childGate.release();
      await running;
      expect(turn.resultAt() - releasedAt).toBeLessThanOrEqual(2_000 + 200);
      expect((await h.log()).filter((e) => e.type === "session.turn_completed")).toHaveLength(1);
      expect(h.errors).toEqual([]);
    });
  });

  it("cancels a wait on an independent asynchronous child without stopping the child", async () => {
    const childGate = gate(); let parentTurns = 0;
    const h = await harness({ async run(input) {
      const write = journalWriter(input);
      if (input.execution?.isChild) { await childGate.promise; await write(text("background done")); return "finished"; }
      if (++parentTurns > 1) { await write(text("callback processed")); return "finished"; }
      const call = tool("background"); await write(call);
      const accepted = await input.subagents!.delegate({ prompt: "child", runInBackground: true }, { toolUseId: "background" }) as { childId: string; executionId: string };
      const acceptedResult = result("background", accepted); await write(acceptedResult);
      const query = event("agent.tool_use", { toolUseId: "wait-bg", name: "get_subagent_result", input: { childId: accepted.childId, wait: true } }); await write(query);
      const done = await input.subagents!.getResult({ ...accepted, wait: true }, { toolUseId: "wait-bg" });
      await write(result("wait-bg", done));
      return "finished";
    } }, { leaseMs: 300 });
    await h.enqueue(); const running = h.router.handleNewEvent(h.parent.id, h.agent);
    await until(async () => (await h.stores.sessionStore.getById(h.parent.id))?.status === "waiting");
    await acceptInterrupt(h.stores.pendingEventStore, h.parent.id, h.router); await running;
    expect((await h.stores.delegationStore.list("tenant", h.parent.id))[0].status).toBe("running");
    childGate.release(); expect(await h.router.waitForIdle(4000)).toBe(true);
    expect((await h.stores.delegationStore.list("tenant", h.parent.id))[0].status).toBe("completed");
    expect(parentTurns).toBe(2);
    expect(h.errors).toEqual([]);
  });

  it("bounds child concurrency while a queued child waited on by the parent can obtain a slot", async () => {
    const firstGate = gate(); let active = 0; let maximum = 0; let parentTurns = 0;
    const h = await harness({ async run(input) {
      const write = journalWriter(input);
      if (input.execution?.isChild) {
        maximum = Math.max(maximum, ++active);
        if (input.message.content[0].type === "text" && input.message.content[0].text === "first") await firstGate.promise;
        await write(text("child done")); active--; return "finished";
      }
      if (++parentTurns > 1) { await write(text("callback")); return "finished"; }
      const first = tool("first"); await write(first);
      const accepted = await input.subagents!.delegate({ prompt: "first", runInBackground: true }, { toolUseId: "first" });
      const firstResult = result("first", accepted); await write(firstResult);
      const second = tool("second"); await write(second);
      const done = await input.subagents!.delegate({ prompt: "second", runInBackground: false }, { toolUseId: "second" });
      await write(result("second", done)); await write(text("parent done"));
      return "finished";
    } }, { quota: 1 });
    await h.enqueue(); const running = h.router.handleNewEvent(h.parent.id, h.agent);
    await until(async () => (await h.stores.delegationStore.list("tenant", h.parent.id)).length === 2);
    expect((await h.stores.delegationStore.list("tenant", h.parent.id)).map((e) => e.status).sort()).toEqual(["queued", "running"]);
    firstGate.release(); await running; expect(await h.router.waitForIdle(4000)).toBe(true);
    expect(maximum).toBe(1);
    expect((await h.stores.delegationStore.list("tenant", h.parent.id)).every((e) => e.status === "completed")).toBe(true);
    expect(h.errors).toEqual([]);
  });
  it("starts a queued synchronous child as soon as a sibling frees its slot, without polling for one", async () => {
    const firstGate = gate(); let secondStartedAt = 0;
    const h = await harness({ async run(input) {
      const write = journalWriter(input);
      if (input.execution?.isChild) {
        const prompt = input.message.content[0].type === "text" ? input.message.content[0].text : "";
        if (prompt === "first") await firstGate.promise;
        else secondStartedAt = Date.now();
        await write(text("child done")); return "finished";
      }
      if (input.message.source === "subagent_result") return "finished";
      const first = tool("first"); await write(first);
      await write(result("first", await input.subagents!.delegate({ prompt: "first", runInBackground: true }, { toolUseId: "first" })));
      const second = tool("second"); await write(second);
      await write(result("second", await input.subagents!.delegate({ prompt: "second", runInBackground: false }, { toolUseId: "second" })));
      return "finished";
    } }, { quota: 1 });
    // The production claim retry backoff: 100 ms doubling up to 5 s.
    const router = h.makeRouter({ pendingClaimRetryMinMs: 100, pendingClaimRetryMaxMs: 5_000 });
    await h.enqueue(); void router.handleNewEvent(h.parent.id, h.agent);
    await until(async () => (await h.stores.delegationStore.list("tenant", h.parent.id)).map((e) => e.status).sort().join() === "queued,running");
    // Each attempt claims, promotes and tries startExecution under the global
    // delegation lock; a child waiting for a slot makes none until one frees.
    const starts = vi.spyOn(h.stores.delegationStore, "startExecution");
    await sleep(1_600);
    expect(starts).not.toHaveBeenCalled();

    const releasedAt = Date.now();
    firstGate.release();
    await until(async () => secondStartedAt > 0);
    expect(secondStartedAt - releasedAt).toBeLessThan(500);
    expect(await router.waitForIdle(4000)).toBe(true);
    expect(h.errors).toEqual([]);
  });

  it("finishes the parent first, keeps the shared Sandbox usable, and processes one durable asynchronous result", async () => {
    const childGate = gate();
    const parentInputs: AdapterInput[] = [];
    let childId = "";
    const h = await harness({ async run(input) {
      const write = journalWriter(input);
      if (input.execution?.isChild) {
        childId = input.sessionId;
        expect(input.subagents).toBeUndefined();
        expect(input.agent.mcpServers ?? []).toEqual([]);
        await childGate.promise;
        expect(await input.toolExecutor!.readFile("/tmp/shared-parent-file")).toBe("same sandbox");
        await input.toolExecutor!.writeFile("answer.txt", "saved after parent");
        await write(text("child final"));
        return "finished";
      }
      parentInputs.push(input);
      if (input.message.source === "subagent_result") { await write(text("processed child result")); return "finished"; }
      await input.toolExecutor!.writeFile("/tmp/shared-parent-file", "same sandbox");
      const call = tool("delegate"); await write(call);
      const accepted = await input.subagents!.delegate({ prompt: "child", runInBackground: true }, { toolUseId: "delegate" });
      await write(result("delegate", accepted));
      await write(text("parent done"));
      return "finished";
    } });
    await h.enqueue();
    await h.router.handleNewEvent(h.parent.id, h.agent);
    expect((await h.log()).filter((e) => e.type === "session.turn_completed")).toHaveLength(1);
    expect((await h.stores.delegationStore.list("tenant", h.parent.id))[0].status).toBe("running");
    childGate.release();
    expect(await h.router.waitForIdle(4000)).toBe(true);
    const execution = (await h.stores.delegationStore.list("tenant", h.parent.id))[0];
    expect(execution.status).toBe("completed");
    expect(execution.notificationStatus).toBe("processed");
    expect(parentInputs).toHaveLength(2);
    expect(parentInputs[1].message.source).toBe("subagent_result");
    expect(parentInputs[1].history.some((e) => (e.type as string) === "subagent.result")).toBe(false);
    expect((await h.log()).filter((e) => e.type === "subagent.result")).toHaveLength(1);
    expect((await h.log(childId)).some((e) => e.type === "agent.message")).toBe(true);
    expect(h.errors).toEqual([]);
  });

  it("holds one parent Turn for a synchronous result and serializes the user's queued input after it", async () => {
    const childGate = gate();
    const parentTurns: string[] = [];
    const h = await harness({ async run(input) {
      const write = journalWriter(input);
      if (input.execution?.isChild) { await childGate.promise; await write(text("child final")); return "finished"; }
      parentTurns.push(input.turnId);
      if (parentTurns.length > 1) { await write(text("user followup")); return "finished"; }
      const call = tool("sync"); await write(call);
      const done = await input.subagents!.delegate({ prompt: "child", runInBackground: false }, { toolUseId: "sync" });
      expect(done).toMatchObject({ status: "completed", runInBackground: false });
      await write(result("sync", done)); await write(text("parent continued"));
      return "finished";
    } });
    await h.enqueue(); const running = h.router.handleNewEvent(h.parent.id, h.agent);
    await until(async () => (await h.stores.sessionStore.getById(h.parent.id))?.status === "waiting");
    await h.enqueue("followup");
    expect(parentTurns).toHaveLength(1);
    expect((await h.log()).some((e) => e.type === "session.turn_completed")).toBe(false);
    childGate.release(); await running;
    expect(await h.router.waitForIdle(2000)).toBe(true);
    expect(parentTurns).toHaveLength(2);
    const log = await h.log();
    expect(log.filter((e) => e.type === "agent.tool_result")).toHaveLength(1);
    expect(log.filter((e) => e.type === "subagent.result_claimed")).toHaveLength(0);
    expect(h.errors).toEqual([]);
  });

  it.each([false, true])("resume retains origin and tools with a fresh budget after exhaustion=%s", async (exhausted) => {
    let childId = "";
    let childTurns = 0;
    let parentTurns = 0;
    const h = await harness({ async run(input) {
      const write = journalWriter(input);
      if (input.execution?.isChild) {
        childTurns++;
        expect(input.execution).toMatchObject({ maxModelSteps: 500 });
        expect(input.resume).toBeUndefined();
        if (childTurns === 1) {
          const call = event("agent.tool_use", { toolUseId: "write", name: "write", input: { path: "one.txt", content: "one" } });
          await write(call); await input.toolExecutor!.writeFile("one.txt", "one"); await write(result("write", "saved"));
          if (exhausted) { await write(event("session.error", { error: { code: "model_step_budget_exhausted", message: "Model step budget exhausted (500)" } })); return "finished"; }
        } else {
          expect(input.history.some((event) => event.type === "agent.tool_result" && event.toolUseId === "write")).toBe(true);
          expect(await input.toolExecutor!.readFile("one.txt")).toBe("one");
        }
        await write(text(`child ${childTurns}`)); return "finished";
      }
      parentTurns++;
      const id = `call${parentTurns}`; const call = tool(id); await write(call);
      const output = await input.subagents!.delegate({ prompt: "child", resume: childId || undefined, runInBackground: false }, { toolUseId: id }) as { childId: string };
      childId = output.childId; await write(result(id, output)); await write(text("done"));
      return "finished";
    } });
    await h.enqueue(); await h.router.handleNewEvent(h.parent.id, h.agent);
    const initial = await h.stores.delegationStore.list("tenant", h.parent.id);
    expect(initial).toHaveLength(1);
    expect(initial[0].status).toBe(exhausted ? "budget_exhausted" : "completed");
    if (exhausted) expect(initial[0].result).toMatchObject({ output: "", reason: "Model step budget exhausted (500)" });
    const origin = (await h.stores.sessionStore.getById(childId))!.delegation;
    await h.enqueue("resume"); await h.makeRouter().handleNewEvent(h.parent.id, h.agent);
    expect(childTurns).toBe(2);
    const executions = await h.stores.delegationStore.list("tenant", h.parent.id);
    expect(executions).toHaveLength(2);
    expect(new Set(executions.map((e) => e.childId)).size).toBe(1);
    expect(executions.every(e => e.maxSteps === 500)).toBe(true);
    expect(executions.find(e => e.id !== initial[0].id)?.status).toBe("completed");
    expect((await h.stores.sessionStore.getById(childId))!.delegation).toEqual(origin);
    expect(h.errors).toEqual([]);
  });

  it("reports final model errors instead of old commentary as success", async () => {
    const h = await harness({ async run(input) {
      const write = journalWriter(input);
      if (input.execution?.isChild) {
        await input.toolExecutor!.writeFile("partial.txt", "saved");
        await write(text("older commentary"));
        await write(event("session.error", { error: { code: "stream_read_error", message: "stream failed" } })); return "finished";
      }
      const call = tool("call"); await write(call);
      const output = await input.subagents!.delegate({ prompt: "child", runInBackground: false }, { toolUseId: "call" });
      expect(output).toMatchObject({ status: "failed", result: { output: "", reason: "stream failed" } });
      expect(await input.toolExecutor!.readFile("partial.txt")).toBe("saved");
      await write(result("call", output)); await write(text("failure acknowledged"));
      return "finished";
    } });
    await h.enqueue(); await h.router.handleNewEvent(h.parent.id, h.agent);
    expect(h.errors).toEqual([]);
  });

  it("continues the original Turn from the event log when the Runner is lost after acceptance and before the child completes", async () => {
    const contextStart = event("agent.context_start", { sdk: "pi@0.83.0" });
    const call = event("agent.context_entry", { sdk: "pi@0.83.0", entry: { id: "parent-call", parentId: null, type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", id: "lost-wait", name: "Agent", arguments: { prompt: "child" } }], stopReason: "toolUse" } },
      presentation: { version: 1, blocks: [{ type: "agent.tool_use", index: 0 }] } });
    const turns: AdapterInput[] = [];
    const h = await harness({ async run(input) {
      const write = journalWriter(input);
      if (input.execution?.isChild) { await write(text("child answer after takeover")); return "finished"; }
      turns.push(input);
      if (turns.length > 1) { await write(text("continued original Turn")); return "finished"; }
      await input.execution?.onResolved?.({ model: "test", thinking: "low", thinkingSource: "agent" });
      // The tool request is durable before Pi runs the tool.
      await write(contextStart); await write(call);
      await input.subagents!.delegate({ prompt: "child", runInBackground: false }, { toolUseId: "lost-wait" });
      throw new Error("A lost Runner never observes the delegation result");
    } });
    // The Runner is lost right after the acceptance transaction commits: its
    // claim lapses before it can wake the child or write anything else.
    const accept = h.stores.delegationStore.accept.bind(h.stores.delegationStore);
    vi.spyOn(h.stores.delegationStore, "accept").mockImplementationOnce(async (input, fence) => {
      await accept(input, fence);
      await h.stores.pendingEventStore.releaseClaim(h.parent.id, fence.eventId, fence);
      throw new PendingEventClaimLostError(h.parent.id, fence.eventId, fence.ownerId, fence.generation);
    });
    const pending = await h.enqueue();
    await h.router.handleNewEvent(h.parent.id, h.agent);
    const [execution] = await h.stores.delegationStore.list("tenant", h.parent.id);
    expect(execution.status).toBe("queued");
    const originalTurn = turns[0].turnId;
    expect(await h.stores.delegationStore.listWaits(h.parent.id, pending.id)).toEqual([{
      tenantId: "tenant", callerSessionId: h.parent.id, callerTurnId: originalTurn, callerToolUseId: "lost-wait",
      executionId: execution.id, parentPendingEventId: pending.id, status: "waiting",
      config: { model: "test", thinking: "low" },
    }]);

    // A later Agent edit must not change the configuration of the resumed Turn.
    await h.stores.agentStore.update(h.agent.id, { model: "unrelated/new-configuration" });
    const replacement = h.makeRouter();
    await replacement.recoverPendingEvents();
    expect(await replacement.waitForIdle(4000)).toBe(true);

    expect(turns).toHaveLength(2);
    const resumed = turns[1];
    expect(resumed).toMatchObject({ turnId: originalTurn, agent: { model: "test" }, execution: { thinking: "low" },
      resume: { completedModelSteps: 0, blockBase: 0 } });
    expect(resumed.history.filter(e => e.type === "agent.context_start")).toHaveLength(1);
    expect(resumed.history.filter(e => e.type === "agent.context_entry")).toEqual([expect.objectContaining({ id: call.id, turnId: originalTurn })]);
    const results = resumed.history.filter(e => e.type === "agent.tool_result");
    expect(results).toEqual([expect.objectContaining({ toolUseId: "lost-wait", isError: false })]);
    expect(JSON.stringify(results[0])).toContain("child answer after takeover");
    const log = await h.log();
    expect(log.filter(e => e.type === "agent.context_entry")).toHaveLength(1);
    expect(log.filter(e => e.type === "agent.tool_result")).toHaveLength(1);
    expect(log.filter(e => e.type === "session.error")).toEqual([]);
    expect(log.filter(e => e.type === "session.turn_completed")).toEqual([expect.objectContaining({ data: expect.objectContaining({ turnId: originalTurn }) })]);
    expect((await h.stores.delegationStore.getExecution("tenant", execution.id))?.status).toBe("completed");
    // The lost Runner reports its lost claim as it stops; nothing else failed.
    expect(h.errors).toEqual([expect.any(PendingEventClaimLostError)]);
  });
  // Which durable boundaries end such a Turn is planResume's table; this is its wiring.
  it("takes the outcome of a taken-over Child execution from its own input on, whatever an earlier attempt named its Turn", async () => {
    const h = await harness({ async run(input) {
      if (!input.execution?.isChild) throw new Error("The parent's Runner is lost");
      await journalWriter(input)(text("child answer after takeover"));
      return "finished";
    } });
    const pending = await h.enqueue();
    const claim = (await h.stores.pendingEventStore.claim(h.parent.id, "dead-host", 30000))!;
    const fence = { eventId: pending.id, ownerId: claim.ownerId, generation: claim.generation };
    const promoted = await h.stores.eventLogStore.append(h.parent.id, { type: pending.type, data: pending.data,
      sessionThreadId: "sthr_primary", idempotencyKey: `pending:${pending.id}`, pendingFence: fence });
    const execution = await h.stores.delegationStore.accept({ tenantId: "tenant", callerSessionId: h.parent.id,
      callerTurnId: `turn_${promoted.seq}_a1`, callerToolUseId: "call", prompt: "child", mode: "sync", parentModel: "test",
      maxSteps: 30, sandboxSessionId: h.parent.id }, fence);
    // An earlier Turn of the Child Session ended in an error; it is not this execution's.
    await h.stores.eventLogStore.append(execution.childId, { type: "session.error",
      data: { turnId: "earlier-turn", error: { code: "adapter_error", message: "an earlier Turn failed" } }, sessionThreadId: "sthr_primary" });
    // The child's first attempt named the Turn and was lost. The name is
    // opaque: it says nothing about where the Turn's input is in the log.
    const lost = (await h.stores.pendingEventStore.claim(execution.childId, "dead-host", 30000))!;
    const lostFence = { eventId: execution.pendingEventId, ownerId: lost.ownerId, generation: lost.generation };
    const input = (await h.stores.pendingEventStore.peek(execution.childId))!;
    await h.stores.eventLogStore.append(execution.childId, { type: input.type, data: input.data,
      sessionThreadId: "sthr_primary", idempotencyKey: `pending:${input.id}`, pendingFence: lostFence });
    await h.stores.delegationStore.startExecution(execution.id, lostFence, "child-turn", {}, 4);
    await h.stores.eventLogStore.append(execution.childId, { type: "agent.context_start",
      data: { ...event("agent.context_start", { sdk: "pi@0.83.0" }), turnId: "child-turn" }, sessionThreadId: "sthr_primary", pendingFence: lostFence });
    await h.stores.pendingEventStore.releaseClaim(execution.childId, execution.pendingEventId, lostFence);

    const child = (await h.stores.sessionStore.getById(execution.childId))!;
    await h.router.handleNewEvent(child.id, child.agent);

    expect((await h.log(child.id)).filter(e => e.type === "session.turn_completed"))
      .toEqual([expect.objectContaining({ data: expect.objectContaining({ turnId: "child-turn" }) })]);
    expect(await h.stores.delegationStore.getExecution("tenant", execution.id)).toMatchObject({ status: "completed",
      result: { status: "completed", output: "child answer after takeover" } });
    expect(h.errors).toEqual([]);
  });

  it("does not restart a consumed-wait parent after a durable turn_aborted but before its completion marker", async () => {
    let parentRuns = 0;
    const h = await harness({ async run(input: AdapterInput) { const write = journalWriter(input); parentRuns++; await write(text("unexpected extra model execution")); return "finished"; } });
    const pending = await h.enqueue();
    const claim = (await h.stores.pendingEventStore.claim(h.parent.id, "dead-host", 30000))!;
    const fence = { eventId: pending.id, ownerId: claim.ownerId, generation: claim.generation };
    const promoted = await h.stores.eventLogStore.append(h.parent.id, {
      type: pending.type, data: pending.data, sessionThreadId: "sthr_primary",
      idempotencyKey: `pending:${pending.id}`, pendingFence: fence,
    });
    const originalTurn = `turn_${promoted.seq}_a${claim.generation}`;
    const call = tool("finished-call");
    const caller = { tenantId: "tenant", callerSessionId: h.parent.id, callerTurnId: originalTurn, callerToolUseId: "finished-call" };
    const child = await h.stores.delegationStore.accept({ ...caller, prompt: "child", mode: "sync", parentModel: "test", maxSteps: 30,
      sandboxSessionId: h.parent.id }, fence);
    const childClaim = (await h.stores.pendingEventStore.claim(child.childId, "dead-host", 30000))!;
    const childFence = { eventId: child.pendingEventId, ownerId: childClaim.ownerId, generation: childClaim.generation };
    await h.stores.delegationStore.startExecution(child.id, childFence, "child-turn", {}, 4);
    await h.stores.delegationStore.finishExecution(child.id, childFence, { status: "completed", output: "done", reason: "finished", trace: { sessionId: child.childId, turnId: "child-turn" } });
    await h.stores.pendingEventStore.ack(child.childId, child.pendingEventId, childFence);
    await h.stores.delegationStore.consumeResult(child.id, caller, fence, { type: "agent.tool_result",
      data: { ...result("finished-call", "done"), turnId: originalTurn }, sessionThreadId: "sthr_primary" });
    await h.stores.eventLogStore.append(h.parent.id, { type: "agent.message", data: { ...text("parent already finished"), turnId: originalTurn }, sessionThreadId: "sthr_primary", pendingFence: fence });
    await h.stores.eventLogStore.append(h.parent.id, { type: "agent.tool_use", data: { ...event("agent.tool_use", { toolUseId: "ordinary-tool", name: "bash", input: {} }), turnId: originalTurn }, sessionThreadId: "sthr_primary", pendingFence: fence });
    await h.stores.eventLogStore.append(h.parent.id, { type: "agent.tool_result", data: { ...result("ordinary-tool", "Execution interrupted; external effects are uncertain"), isError: true, turnId: originalTurn }, sessionThreadId: "sthr_primary", pendingFence: fence });
    await h.stores.eventLogStore.append(h.parent.id, { type: "session.turn_aborted", data: { turnId: originalTurn }, sessionThreadId: "sthr_primary", pendingFence: fence });
    await h.stores.pendingEventStore.releaseClaim(h.parent.id, pending.id, claim);
    await h.router.recoverPendingEvents();
    expect(await h.router.waitForIdle(4000)).toBe(true);
    expect(parentRuns).toBe(0);
    expect((await h.log()).filter((entry) => entry.type === "session.turn_completed")).toHaveLength(1);
    expect(h.errors).toEqual([]);
  });

});
