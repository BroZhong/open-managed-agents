import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createMemoryStores } from "@oma-server/store-memory";
import { DefaultSandboxManager, FakeSandboxClient } from "@oma-server/sandbox";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import type { Adapter, AdapterInput, SessionEvent } from "@open-managed-agents/adapter-core";
import { SessionRouter } from "../src/session-router.js";

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
  const agent = await stores.agentStore.create({ tenantId: "tenant", name: "Test", model: "test", system: "test", runtime: "pi-agent", sandbox: { enabled: true } });
  const workspace = await stores.workspaceStore.create({ tenantId: "tenant" });
  const parent = await stores.sessionStore.create({ tenantId: "tenant", agentId: agent.id, agent, workspaceId: workspace.id });
  const errors: unknown[] = [];
  const makeRouter = () => new SessionRouter({
    ...stores, eventStreamHub: new InProcessEventStreamHub(), resolveAdapter: () => adapter,
    sandboxManager: new DefaultSandboxManager({ sandboxClient: sandbox, provisionSources: {} }),
    workspaceMount: { bucket: "agentry", agentName: "agentry-workspace", pvName: "agentry-workspace-oss", credentialProviderName: "agentry-oss-rw" },
    maxConcurrentSubagents: options.quota,
    pendingClaimLeaseMs: options.leaseMs ?? 30000,
    pendingClaimRenewIntervalMs: options.leaseMs ? Math.floor(options.leaseMs / 3) : 1000,
    pendingClaimRetryMinMs: 10, pendingClaimRetryMaxMs: 20,
    onDrainError: ({ error }) => errors.push(error),
  });
  const router = makeRouter();
  const enqueue = async (message = "start") => stores.pendingEventStore.enqueue(parent.id, {
    type: "user.message", data: { content: [{ type: "text", text: message }] }, sessionThreadId: "sthr_primary",
  });
  const log = async (id = parent.id) => (await stores.eventLogStore.getEvents(id, { limit: 1000 })).data;
  return { stores, sandbox, agent, parent, router, makeRouter, enqueue, log, errors };
}

describe("Host-owned delegation through the Session Router", () => {
  it("accepts an Interrupt on another Host and stops synchronous children while preserving queued parent input", async () => {
    let childStarted = false;
    let parentTurns = 0;
    const h = await harness({ async *run(input) {
      if (input.execution?.isChild) {
        childStarted = true;
        await new Promise<void>((resolve) => input.signal!.addEventListener("abort", () => resolve(), { once: true }));
        return;
      }
      if (++parentTurns > 1) { yield text("queued input processed"); return; }
      const call = tool("interrupt-sync"); yield call;
      const done = await input.subagents!.delegate({ prompt: "child", runInBackground: false }, { toolUseId: "interrupt-sync", checkpoint: [call] });
      yield result("interrupt-sync", done);
    } }, { leaseMs: 150 });
    await h.enqueue(); const running = h.router.handleNewEvent(h.parent.id, h.agent);
    await until(async () => childStarted && (await h.stores.sessionStore.getById(h.parent.id))?.status === "waiting");
    await h.enqueue("later input");
    expect(await h.makeRouter().requestInterrupt(h.parent.id)).toEqual({ requested: true, interrupted: false });
    await running;
    expect(await h.router.waitForIdle(4000)).toBe(true);
    const executions = await h.stores.delegationStore.list("tenant", h.parent.id);
    expect(executions[0].status).toBe("interrupted");
    expect((await h.log()).filter((e) => e.type === "session.turn_aborted")).toHaveLength(1);
    expect(parentTurns).toBe(2);
    expect(h.errors).toEqual([]);
  });

  it("cancels a wait on an independent asynchronous child without stopping the child", async () => {
    const childGate = gate(); let parentTurns = 0;
    const h = await harness({ async *run(input) {
      if (input.execution?.isChild) { await childGate.promise; yield text("background done"); return; }
      if (++parentTurns > 1) { yield text("callback processed"); return; }
      const call = tool("background"); yield call;
      const accepted = await input.subagents!.delegate({ prompt: "child", runInBackground: true }, { toolUseId: "background", checkpoint: [call] }) as { childId: string; executionId: string };
      const acceptedResult = result("background", accepted); yield acceptedResult;
      const query = event("agent.tool_use", { toolUseId: "wait-bg", name: "get_subagent_result", input: { childId: accepted.childId, wait: true } }); yield query;
      const done = await input.subagents!.getResult({ ...accepted, wait: true }, { toolUseId: "wait-bg", checkpoint: [call, acceptedResult, query] });
      yield result("wait-bg", done);
    } }, { leaseMs: 300 });
    await h.enqueue(); const running = h.router.handleNewEvent(h.parent.id, h.agent);
    await until(async () => (await h.stores.sessionStore.getById(h.parent.id))?.status === "waiting");
    await h.router.requestInterrupt(h.parent.id); await running;
    expect((await h.stores.delegationStore.list("tenant", h.parent.id))[0].status).toBe("running");
    childGate.release(); expect(await h.router.waitForIdle(4000)).toBe(true);
    expect((await h.stores.delegationStore.list("tenant", h.parent.id))[0].status).toBe("completed");
    expect(parentTurns).toBe(2);
    expect(h.errors).toEqual([]);
  });

  it("bounds child concurrency while a queued child waited on by the parent can obtain a slot", async () => {
    const firstGate = gate(); let active = 0; let maximum = 0; let parentTurns = 0;
    const h = await harness({ async *run(input) {
      if (input.execution?.isChild) {
        maximum = Math.max(maximum, ++active);
        if (input.message.content[0].type === "text" && input.message.content[0].text === "first") await firstGate.promise;
        yield text("child done"); active--; return;
      }
      if (++parentTurns > 1) { yield text("callback"); return; }
      const first = tool("first"); yield first;
      const accepted = await input.subagents!.delegate({ prompt: "first", runInBackground: true }, { toolUseId: "first", checkpoint: [first] });
      const firstResult = result("first", accepted); yield firstResult;
      const second = tool("second"); yield second;
      const done = await input.subagents!.delegate({ prompt: "second", runInBackground: false }, { toolUseId: "second", checkpoint: [first, firstResult, second] });
      yield result("second", done); yield text("parent done");
    } }, { quota: 1 });
    await h.enqueue(); const running = h.router.handleNewEvent(h.parent.id, h.agent);
    await until(async () => (await h.stores.delegationStore.list("tenant", h.parent.id)).length === 2);
    expect((await h.stores.delegationStore.list("tenant", h.parent.id)).map((e) => e.status).sort()).toEqual(["queued", "running"]);
    firstGate.release(); await running; expect(await h.router.waitForIdle(4000)).toBe(true);
    expect(maximum).toBe(1);
    expect((await h.stores.delegationStore.list("tenant", h.parent.id)).every((e) => e.status === "completed")).toBe(true);
    expect(h.errors).toEqual([]);
  });
  it("finishes the parent first, keeps the shared Sandbox usable, and processes one durable asynchronous result", async () => {
    const childGate = gate();
    const parentInputs: AdapterInput[] = [];
    let childId = "";
    const h = await harness({ async *run(input) {
      if (input.execution?.isChild) {
        childId = input.sessionId;
        expect(input.subagents).toBeUndefined();
        expect(input.agent.mcpServers ?? []).toEqual([]);
        await childGate.promise;
        expect(await input.toolExecutor!.readFile("/tmp/shared-parent-file")).toBe("same sandbox");
        await input.toolExecutor!.writeFile("answer.txt", "saved after parent");
        yield text("child final");
        return;
      }
      parentInputs.push(input);
      if (input.message.source === "subagent_result") { yield text("processed child result"); return; }
      await input.toolExecutor!.writeFile("/tmp/shared-parent-file", "same sandbox");
      const call = tool("delegate"); yield call;
      const accepted = await input.subagents!.delegate({ prompt: "child", runInBackground: true }, { toolUseId: "delegate", checkpoint: [call] });
      yield result("delegate", accepted);
      yield text("parent done");
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
    expect(parentInputs[1].history.some((e) => e.type === "subagent.result")).toBe(false);
    expect((await h.log()).filter((e) => e.type === "subagent.result")).toHaveLength(1);
    expect((await h.log(childId)).some((e) => e.type === "agent.message")).toBe(true);
    expect(h.errors).toEqual([]);
  });

  it("holds one parent Turn for a synchronous result and serializes the user's queued input after it", async () => {
    const childGate = gate();
    const parentTurns: string[] = [];
    const h = await harness({ async *run(input) {
      if (input.execution?.isChild) { await childGate.promise; yield text("child final"); return; }
      parentTurns.push(input.turnId);
      if (parentTurns.length > 1) { yield text("user followup"); return; }
      const call = tool("sync"); yield call;
      const done = await input.subagents!.delegate({ prompt: "child", runInBackground: false }, { toolUseId: "sync", checkpoint: [call] });
      expect(done).toMatchObject({ status: "completed", runInBackground: false });
      yield result("sync", done); yield text("parent continued");
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

  it("resume rebuilds a child in a later parent Turn and retains its creation origin and completed tools", async () => {
    let childId = "";
    let childTurns = 0;
    let parentTurns = 0;
    const h = await harness({ async *run(input) {
      if (input.execution?.isChild) {
        childTurns++;
        if (childTurns === 1) {
          const call = event("agent.tool_use", { toolUseId: "write", name: "write", input: { path: "one.txt", content: "one" } });
          yield call; await input.toolExecutor!.writeFile("one.txt", "one"); yield result("write", "saved");
        } else {
          expect(input.history.some((event) => event.type === "agent.tool_result" && event.toolUseId === "write")).toBe(true);
          expect(await input.toolExecutor!.readFile("one.txt")).toBe("one");
        }
        yield text(`child ${childTurns}`); return;
      }
      parentTurns++;
      const id = `call${parentTurns}`; const call = tool(id); yield call;
      const output = await input.subagents!.delegate({ prompt: "child", resume: childId || undefined, runInBackground: false }, { toolUseId: id, checkpoint: [call] }) as { childId: string };
      childId = output.childId; yield result(id, output); yield text("done");
    } });
    await h.enqueue(); await h.router.handleNewEvent(h.parent.id, h.agent);
    const origin = (await h.stores.sessionStore.getById(childId))!.delegation;
    await h.enqueue("resume"); await h.makeRouter().handleNewEvent(h.parent.id, h.agent);
    expect(childTurns).toBe(2);
    const executions = await h.stores.delegationStore.list("tenant", h.parent.id);
    expect(executions).toHaveLength(2);
    expect(new Set(executions.map((e) => e.childId)).size).toBe(1);
    expect((await h.stores.sessionStore.getById(childId))!.delegation).toEqual(origin);
    expect(h.errors).toEqual([]);
  });

  it("reports final model errors instead of old commentary as success", async () => {
    const h = await harness({ async *run(input) {
      if (input.execution?.isChild) {
        await input.toolExecutor!.writeFile("partial.txt", "saved");
        yield text("older commentary");
        yield event("session.error", { error: { code: "stream_read_error", message: "stream failed" } }); return;
      }
      const call = tool("call"); yield call;
      const output = await input.subagents!.delegate({ prompt: "child", runInBackground: false }, { toolUseId: "call", checkpoint: [call] });
      expect(output).toMatchObject({ status: "failed", result: { output: "", reason: "stream failed" } });
      expect(await input.toolExecutor!.readFile("partial.txt")).toBe("saved");
      yield result("call", output); yield text("failure acknowledged");
    } });
    await h.enqueue(); await h.router.handleNewEvent(h.parent.id, h.agent);
    expect(h.errors).toEqual([]);
  });

  it("restores a persisted wait checkpoint into the original parent Turn without rerunning its tool", async () => {
    let continuation: AdapterInput | undefined;
    const h = await harness({ async *run(input) {
      if (input.execution?.isChild) { yield text("recovered queued child"); return; }
      continuation = input;
      expect(input.continuation).toBeDefined();
      expect(input.history.filter((e) => e.type === "agent.tool_result")).toHaveLength(1);
      yield text("continued original Turn");
    } });
    const pending = await h.enqueue();
    const claim = (await h.stores.pendingEventStore.claim(h.parent.id, "dead-host", 30000))!;
    const fence = { eventId: pending.id, ownerId: claim.ownerId, generation: claim.generation };
    const promoted = await h.stores.eventLogStore.append(h.parent.id, { type: pending.type, data: pending.data, sessionThreadId: "sthr_primary", idempotencyKey: `pending:${pending.id}`, pendingFence: fence });
    const originalTurn = `turn_${promoted.seq}_a${claim.generation}`;
    const call = tool("restored-call");
    await h.stores.delegationStore.accept({ tenantId: "tenant", callerSessionId: h.parent.id, callerTurnId: originalTurn, callerToolUseId: "restored-call", prompt: "child", mode: "sync", maxSteps: 30, sandboxSessionId: h.parent.id, checkpoint: { events: [call] } }, fence);
    await h.stores.pendingEventStore.releaseClaim(h.parent.id, pending.id, claim);
    await h.router.recoverPendingEvents();
    expect(await h.router.waitForIdle(4000)).toBe(true);
    expect(continuation?.turnId).toBe(originalTurn);
    const log = await h.log();
    expect(log.filter((e) => e.type === "agent.tool_use")).toHaveLength(1);
    expect(log.filter((e) => e.type === "agent.tool_result")).toHaveLength(1);
    expect(log.filter((e) => e.type === "session.turn_completed")).toHaveLength(1);
    expect(h.errors).toEqual([]);
  });
  it.each(["idle", "recovery_required"])("does not restart a consumed-wait parent after durable %s but before its completion marker", async (boundary) => {
    let parentRuns = 0;
    const h = await harness({ async *run() { parentRuns++; yield text("unexpected extra model execution"); } });
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
    const child = await h.stores.delegationStore.accept({ ...caller, prompt: "child", mode: "sync", maxSteps: 30,
      sandboxSessionId: h.parent.id, checkpoint: { events: [call] } }, fence);
    const childClaim = (await h.stores.pendingEventStore.claim(child.childId, "dead-host", 30000))!;
    const childFence = { eventId: child.pendingEventId, ownerId: childClaim.ownerId, generation: childClaim.generation };
    await h.stores.delegationStore.startExecution(child.id, childFence, "child-turn", {}, 4);
    await h.stores.delegationStore.finishExecution(child.id, childFence, { status: "completed", output: "done", reason: "finished", trace: { sessionId: child.childId, turnId: "child-turn" } });
    await h.stores.pendingEventStore.ack(child.childId, child.pendingEventId, childFence);
    await h.stores.delegationStore.consumeResult(child.id, caller, fence, { type: "agent.tool_result",
      data: { ...result("finished-call", "done"), turnId: originalTurn }, sessionThreadId: "sthr_primary" });
    await h.stores.eventLogStore.append(h.parent.id, { type: "agent.message", data: { ...text("parent already finished"), turnId: originalTurn }, sessionThreadId: "sthr_primary", pendingFence: fence });
    if (boundary === "idle") {
      await h.stores.eventLogStore.append(h.parent.id, { type: "session.status_idle", data: {}, sessionThreadId: "sthr_primary",
        idempotencyKey: `pending:${pending.id}:status_idle`, pendingFence: fence });
    } else {
      await h.stores.eventLogStore.append(h.parent.id, { type: "agent.tool_use", data: { ...event("agent.tool_use", { toolUseId: "ordinary-tool", name: "bash", input: {} }), turnId: originalTurn }, sessionThreadId: "sthr_primary", pendingFence: fence });
      await h.stores.eventLogStore.append(h.parent.id, { type: "agent.tool_result", data: { ...result("ordinary-tool", "Execution interrupted; external effects are uncertain"), isError: true, turnId: originalTurn }, sessionThreadId: "sthr_primary", pendingFence: fence });
      await h.stores.eventLogStore.append(h.parent.id, { type: "session.error", data: { turnId: originalTurn, error: { code: "recovery_required", message: "Inspect the uncertain external effects before a new Turn" } }, sessionThreadId: "sthr_primary", pendingFence: fence });
    }
    await h.stores.pendingEventStore.releaseClaim(h.parent.id, pending.id, claim);
    await h.router.recoverPendingEvents();
    expect(await h.router.waitForIdle(4000)).toBe(true);
    expect(parentRuns).toBe(0);
    expect((await h.log()).filter((entry) => entry.type === "session.turn_completed")).toHaveLength(1);
    expect(h.errors).toEqual([]);
  });

});
