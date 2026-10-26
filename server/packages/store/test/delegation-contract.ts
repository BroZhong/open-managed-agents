import { describe, it, expect, beforeEach, afterAll } from "vitest";
import type { WorkspaceMetadataStore, AgentStore, SessionStore, PendingEventStore, EventLogStore, DelegationStore, DelegationAcceptInput, PendingEventFence, DelegationExecution, SandboxObservation, BindingTransition } from "../src/index.js";
export interface DelegationFixture { workspaceStore: WorkspaceMetadataStore; agentStore: AgentStore; sessionStore: SessionStore; pendingEventStore: PendingEventStore; eventLogStore: EventLogStore; delegationStore: DelegationStore }
export function delegationContract(name: string, create: () => Promise<DelegationFixture>, close?: () => Promise<void>) {
  describe(name, () => {
    let stores: DelegationFixture;
    let input: DelegationAcceptInput;
    let parentFence: PendingEventFence;
    const fenceFor = async (child: DelegationExecution, ownerId = "child-owner") => {
      const claim = await stores.pendingEventStore.claim!(child.childId, ownerId, 60_000);
      if (!claim) throw new Error("Unable to claim input");
      return { eventId: claim.event.id, ownerId: claim.ownerId, generation: claim.generation };
    };
    const finish = async (execution: DelegationExecution, fence: PendingEventFence) => stores.delegationStore.finishExecution(execution.id, fence, { status: "completed", reason: "Model finished", output: "done", trace: { sessionId: execution.childId, turnId: "child-turn" } });
    beforeEach(async () => {
      stores = await create();
      const agent = await stores.agentStore.create({ tenantId: "tenant-a", name: "Agent", model: "model", system: "system", runtime: "pi" });
      const parent = await stores.sessionStore.create({ tenantId: "tenant-a", agentId: agent.id, agent, workspaceId: "shared-workspace" });
      await stores.pendingEventStore.enqueue(parent.id, { type: "user.message", data: { content: [{ type: "text", text: "parent" }] }, sessionThreadId: "sthr_primary" });
      const claim = await stores.pendingEventStore.claim!(parent.id, "parent-owner", 60_000);
      parentFence = { eventId: claim!.event.id, ownerId: claim!.ownerId, generation: claim!.generation };
      input = { tenantId: "tenant-a", callerSessionId: parent.id, callerTurnId: "parent-turn", callerToolUseId: "tool-1", prompt: "Do task", mode: "async", parentModel: "provider/parent-model", maxSteps: 30, sandboxSessionId: parent.id };
    });
    afterAll(async () => { await close?.(); });
    it("atomically accepts once per parent tool and keeps immutable child origin", async () => {
      const child = await stores.delegationStore.accept(input, parentFence);
      expect(await stores.delegationStore.accept(input, parentFence)).toEqual(child);
      expect(await stores.pendingEventStore.count(child.childId)).toBe(1);
      const session = await stores.sessionStore.getById(child.childId);
      expect(session).toMatchObject({ workspaceId: "shared-workspace", delegation: { parentSessionId: input.callerSessionId, parentTurnId: "parent-turn", parentToolUseId: "tool-1" } });
      const resumed = await stores.delegationStore.accept({ ...input, resume: child.childId, callerTurnId: "later-turn", callerToolUseId: "tool-2" }, parentFence);
      expect(resumed.childId).toBe(child.childId);
      expect(resumed.id).not.toBe(child.id);
      expect((await stores.sessionStore.getById(child.childId))?.delegation).toEqual(session?.delegation);
      expect(await stores.pendingEventStore.count(child.childId)).toBe(2);
    });
    it("runs a Child Session in its parent's Environment, whatever its Agent is bound to now (ADR-0024)", async () => {
      const agent = await stores.agentStore.create({ tenantId: "tenant-a", name: "Bound", model: "model", system: "system", runtime: "pi", environmentId: "env_agent_then" });
      const parent = await stores.sessionStore.create({ tenantId: "tenant-a", agentId: agent.id, agent, workspaceId: "shared-workspace", environmentId: "env_parent" });
      await stores.agentStore.update(agent.id, { environmentId: "env_agent_now" });
      await stores.pendingEventStore.enqueue(parent.id, { type: "user.message", data: { content: [{ type: "text", text: "parent" }] }, sessionThreadId: "sthr_primary" });
      const claim = await stores.pendingEventStore.claim!(parent.id, "bound-owner", 60_000);
      const fence = { eventId: claim!.event.id, ownerId: claim!.ownerId, generation: claim!.generation };
      const child = await stores.delegationStore.accept({ ...input, callerSessionId: parent.id, sandboxSessionId: parent.id }, fence);
      expect((await stores.sessionStore.getById(child.childId))?.environmentId).toBe("env_parent");
      // The default parent has no Environment, nor do its children.
      const plain = await stores.delegationStore.accept(input, parentFence);
      expect((await stores.sessionStore.getById(plain.childId))?.environmentId).toBeUndefined();
    });
    it("rejects new children in a deleted Workspace while accepted input and resume remain usable", async () => {
      await stores.workspaceStore.create({ tenantId: input.tenantId, id: "shared-workspace" });
      const accepted = await stores.delegationStore.accept(input, parentFence);
      await stores.workspaceStore.softDelete(input.tenantId, "shared-workspace");
      await expect(stores.delegationStore.accept({ ...input, callerToolUseId: "new-child" }, parentFence))
        .rejects.toThrow("Workspace has been deleted");
      expect((await stores.sessionStore.list(input.tenantId)).data).toHaveLength(2);
      expect(await stores.delegationStore.list(input.tenantId, input.callerSessionId)).toHaveLength(1);
      expect(await stores.delegationStore.accept(input, parentFence)).toEqual(accepted);
      expect(await stores.pendingEventStore.count(accepted.childId)).toBe(1);
      const firstFence = await fenceFor(accepted);
      await stores.delegationStore.startExecution(accepted.id, firstFence, "first-turn", {}, 4);
      expect((await finish(accepted, firstFence)).status).toBe("completed");
      await stores.pendingEventStore.ack(accepted.childId, accepted.pendingEventId, firstFence);
      // Session soft deletion is also presentation state, never a Turn interruption.
      await stores.sessionStore.softDelete(input.callerSessionId);
      await stores.sessionStore.softDelete(accepted.childId);
      const resumed = await stores.delegationStore.accept({ ...input, resume: accepted.childId, callerToolUseId: "resume" }, parentFence);
      expect(resumed.childId).toBe(accepted.childId);
      const resumedFence = await fenceFor(resumed);
      await stores.delegationStore.startExecution(resumed.id, resumedFence, "resumed-turn", {}, 4);
      expect((await finish(resumed, resumedFence)).status).toBe("completed");
    });
    it("persists the trusted parent model per input and preserves it across idempotent retries", async () => {
      const first = await stores.delegationStore.accept(input, parentFence);
      expect(first).toMatchObject({ model: "provider/parent-model", modelSource: "parent" });
      expect((await stores.sessionStore.getById(first.childId))?.agent.model).toBe("provider/parent-model");
      const later = { ...input, parentModel: "other-provider/new-parent-model" };
      expect(await stores.delegationStore.accept(later, parentFence)).toEqual(first);
      const resumed = await stores.delegationStore.accept({ ...later, resume: first.childId, callerToolUseId: "resume" }, parentFence);
      expect(resumed).toMatchObject({ childId: first.childId, model: "other-provider/new-parent-model", modelSource: "parent" });
      expect((await stores.delegationStore.getExecution(input.tenantId, first.id))?.model).toBe("provider/parent-model");
      await expect(stores.delegationStore.accept({ ...input, parentModel: "", callerToolUseId: "unresolved" }, parentFence)).rejects.toThrow("Resolved parent model is required");
    });
    it("denies another tenant, unrelated parent, and expired creation owner", async () => {
      const child = await stores.delegationStore.accept(input, parentFence);
      expect(await stores.delegationStore.get("tenant-b", input.callerSessionId, child.childId)).toBeNull();
      expect(await stores.delegationStore.get("tenant-a", "unrelated", child.childId)).toBeNull();
      await expect(stores.delegationStore.accept({ ...input, callerToolUseId: "other", tenantId: "tenant-b" }, parentFence)).rejects.toThrow();
      await stores.pendingEventStore.releaseClaim!(input.callerSessionId, parentFence.eventId, parentFence);
      await expect(stores.delegationStore.accept({ ...input, callerToolUseId: "stale" }, parentFence)).rejects.toThrow();
    });
    it("enforces persisted parent quota while queued child inputs retain FIFO identity", async () => {
      const one = await stores.delegationStore.accept(input, parentFence);
      const two = await stores.delegationStore.accept({ ...input, callerToolUseId: "tool-2" }, parentFence);
      const f1 = await fenceFor(one); const f2 = await fenceFor(two);
      expect((await stores.delegationStore.startExecution(one.id, f1, "child-turn", { model: "model" }, 1))?.status).toBe("running");
      expect(await stores.delegationStore.startExecution(two.id, f2, "child-turn-2", {}, 1)).toBeNull();
      expect((await stores.delegationStore.getByPendingEventId(two.pendingEventId))?.status).toBe("queued");
      await finish(one, f1);
      expect((await stores.delegationStore.startExecution(two.id, f2, "child-turn-2", {}, 1))?.status).toBe("running");
    });
    it("persists the resolved model configuration without losing execution limits and fences updates", async () => {
      const child = await stores.delegationStore.accept(input, parentFence);
      const fence = await fenceFor(child);
      await stores.delegationStore.startExecution(child.id, fence, "child-turn", { runtime: "pi-agent", maxModelSteps: 30, model: "requested" }, 4);
      await stores.delegationStore.updateEffectiveConfig(child.id, fence, { model: "provider/resolved-model", thinking: "high", modelSource: "agent", thinkingSource: "model-default" });
      expect((await stores.delegationStore.getExecution(input.tenantId, child.id))?.effectiveConfig).toEqual({
        runtime: "pi-agent", maxSteps: 30, model: "provider/resolved-model", thinking: "high", modelSource: "agent", thinkingSource: "model-default",
      });
      await stores.pendingEventStore.releaseClaim!(child.childId, fence.eventId, fence);
      await expect(stores.delegationStore.updateEffectiveConfig(child.id, fence, { model: "stale" })).rejects.toThrow();
    });
    it("publishes terminal result and one async notification, then consumes only after tool result append", async () => {
      const child = await stores.delegationStore.accept(input, parentFence);
      const fence = await fenceFor(child);
      await stores.delegationStore.startExecution(child.id, fence, "child-turn", {}, 4);
      const terminal = await finish(child, fence);
      expect(await finish(child, fence)).toEqual(terminal);
      expect(await stores.pendingEventStore.count(input.callerSessionId)).toBe(2);
      expect((await stores.eventLogStore.getEvents(input.callerSessionId)).data.filter((e) => e.type === "subagent.result")).toHaveLength(1);
      const event = { type: "tool.result", data: { turnId: input.callerTurnId, toolUseId: input.callerToolUseId, result: "done" }, sessionThreadId: "sthr_primary" };
      const consumed = await stores.delegationStore.consumeResult(child.id, input, parentFence, event);
      expect(await stores.delegationStore.consumeResult(child.id, input, parentFence, event)).toEqual(consumed);
      expect(await stores.pendingEventStore.count(input.callerSessionId)).toBe(1);
      expect((await stores.delegationStore.getExecution(input.tenantId, child.id))?.notificationStatus).toBe("consumed");
    });
    it("records only the parent Turn configuration for a synchronous wait", async () => {
      const child = await stores.delegationStore.accept({ ...input, mode: "sync", parentThinking: "low", thinking: "high" }, parentFence);
      const caller = { tenantId: "tenant-a", callerSessionId: input.callerSessionId, callerTurnId: "parent-turn" };
      const query = await stores.delegationStore.saveWait({ ...caller, callerToolUseId: "query-tool", executionId: child.id,
        parentPendingEventId: parentFence.eventId, config: { model: "provider/parent-model", thinking: "low" } }, parentFence);
      const waits = await stores.delegationStore.listWaits(input.callerSessionId, parentFence.eventId);
      expect(waits.sort((a, b) => a.callerToolUseId.localeCompare(b.callerToolUseId))).toEqual([
        { ...caller, callerToolUseId: "query-tool", executionId: child.id, parentPendingEventId: parentFence.eventId, status: "waiting", config: { model: "provider/parent-model", thinking: "low" } },
        { ...caller, callerToolUseId: "tool-1", executionId: child.id, parentPendingEventId: parentFence.eventId, status: "waiting", config: { model: "provider/parent-model", thinking: "low" } },
      ]);
      expect(waits).toContainEqual(query);
    });
    it("keeps sync wait bound to exact execution and never queues automatic callback", async () => {
      const child = await stores.delegationStore.accept({ ...input, mode: "sync" }, parentFence);
      const wait = await stores.delegationStore.saveWait({ ...input, executionId: child.id, parentPendingEventId: parentFence.eventId, config: { model: "provider/parent-model" } }, parentFence);
      expect(wait.status).toBe("waiting");
      const f = await fenceFor(child);
      await stores.delegationStore.startExecution(child.id, f, "child-turn", {}, 4); await finish(child, f);
      expect(await stores.pendingEventStore.count(input.callerSessionId)).toBe(1);
      expect((await stores.delegationStore.listWaits(input.callerSessionId, parentFence.eventId))[0]?.executionId).toBe(child.id);
      await stores.delegationStore.consumeResult(child.id, input, parentFence, { type: "tool.result", data: { turnId: "parent-turn" }, sessionThreadId: "sthr_primary" });
      expect((await stores.delegationStore.listWaits(input.callerSessionId, parentFence.eventId))[0]?.status).toBe("consumed");
    });
    it("records steer exactly once, fences old owner, and preserves queued resume on parent withdrawal", async () => {
      const child = await stores.delegationStore.accept({ ...input, mode: "sync" }, parentFence);
      const commandInput = { ...input, callerToolUseId: "steer-tool", childId: child.childId, kind: "steer" as const, message: "Inspect first" };
      const command = await stores.delegationStore.command(commandInput);
      expect(await stores.delegationStore.command(commandInput)).toEqual(command);
      const resumed = await stores.delegationStore.accept({ ...input, resume: child.childId, callerToolUseId: "resume-tool" }, parentFence);
      const interrupted = await stores.delegationStore.command({ ...input, callerToolUseId: "interrupt-tool", childId: child.childId, executionId: child.id, kind: "interrupt", message: "Parent stopped" });
      expect(interrupted.status).toBe("applied");
      expect((await stores.delegationStore.getExecution(input.tenantId, child.id))?.result?.trace.turnId).toBeUndefined();
      expect((await stores.pendingEventStore.peek(child.childId))?.id).toBe(resumed.pendingEventId);
      expect((await stores.delegationStore.listCommands(child.id)).find((c) => c.id === command.id)?.status).toBe("not_applied");
    });
    it("C7 hands a running execution its lost owner left to the claim that takes its input over", async () => {
      const child = await stores.delegationStore.accept(input, parentFence);
      const oldFence = await fenceFor(child);
      await stores.delegationStore.startExecution(child.id, oldFence, "child-turn", { model: "requested" }, 4);
      await stores.delegationStore.updateEffectiveConfig(child.id, oldFence, { model: "provider/resolved", thinking: "high" });
      await stores.pendingEventStore.releaseClaim!(child.childId, oldFence.eventId, oldFence);
      const newFence = await fenceFor(child, "replacement");
      // The Turn the takeover continues keeps its configuration and its slot; the owner is the new claim's.
      const resumed = await stores.delegationStore.startExecution(child.id, newFence, "child-turn", { model: "other" }, 1);
      expect(resumed).toMatchObject({ status: "running", turnId: "child-turn", ownerId: "replacement", generation: newFence.generation,
        effectiveConfig: { model: "provider/resolved", thinking: "high", maxSteps: 30 } });
      expect(resumed?.result).toBeUndefined();
      expect(await stores.delegationStore.startExecution(child.id, newFence, "child-turn", {}, 1)).toEqual(resumed);
      // The lost owner is fenced out; the new one finishes the execution and its commands apply under its generation.
      await expect(finish(child, oldFence)).rejects.toThrow();
      await expect(stores.delegationStore.updateEffectiveConfig(child.id, oldFence, { model: "stale" })).rejects.toThrow();
      const steer = await stores.delegationStore.command({ ...input, callerToolUseId: "steer-after-takeover", childId: child.childId, kind: "steer", message: "Check first" });
      expect(steer).toMatchObject({ status: "accepted", targetGeneration: newFence.generation });
      expect((await stores.delegationStore.applyCommand(steer.id, newFence, { type: "subagent.instruction", data: {}, sessionThreadId: "sthr_primary" })).status).toBe("applied");
      expect((await finish(child, newFence)).status).toBe("completed");
      expect(await stores.pendingEventStore.listUnclaimed(input.callerSessionId, 10)).toEqual([expect.objectContaining({ type: "subagent.result" })]);
    });
    it("C7 names the execution's Turn after the takeover's when no attempt named it in the log", async () => {
      const child = await stores.delegationStore.accept(input, parentFence);
      const oldFence = await fenceFor(child);
      await stores.delegationStore.startExecution(child.id, oldFence, "turn_3_a1", {}, 4);
      await stores.pendingEventStore.releaseClaim!(child.childId, oldFence.eventId, oldFence);
      const newFence = await fenceFor(child, "replacement");
      expect(await stores.delegationStore.startExecution(child.id, newFence, "turn_3_a2", {}, 4)).toMatchObject({ status: "running", turnId: "turn_3_a2" });
    });
    it("C10 counts a sibling whose owner was lost against the parent's limit until its takeover ends it", async () => {
      const lost = await stores.delegationStore.accept(input, parentFence);
      const lostFence = await fenceFor(lost, "lost-owner");
      await stores.delegationStore.startExecution(lost.id, lostFence, "lost-turn", {}, 1);
      await stores.pendingEventStore.releaseClaim!(lost.childId, lostFence.eventId, lostFence);
      const queued = await stores.delegationStore.accept({ ...input, callerToolUseId: "tool-2" }, parentFence);
      const queuedFence = await fenceFor(queued);
      // The lost owner's execution is not ended: it still runs, and occupies the only slot.
      expect(await stores.delegationStore.startExecution(queued.id, queuedFence, "queued-turn", {}, 1)).toBeNull();
      expect((await stores.delegationStore.getExecution(input.tenantId, lost.id))?.status).toBe("running");
      expect((await stores.eventLogStore.getEvents(input.callerSessionId)).data).toEqual([]);
      // Its takeover continues it in the slot it holds and ends it; then the queued sibling starts.
      const takeoverFence = await fenceFor(lost, "takeover");
      expect((await stores.delegationStore.startExecution(lost.id, takeoverFence, "lost-turn", {}, 1))?.status).toBe("running");
      expect(await stores.delegationStore.startExecution(queued.id, queuedFence, "queued-turn", {}, 1)).toBeNull();
      await finish(lost, takeoverFence);
      expect((await stores.delegationStore.startExecution(queued.id, queuedFence, "queued-turn", {}, 1))?.status).toBe("running");
    });
    it("reconciles terminated child executions after their pending inputs have been deleted", async () => {
      const child = await stores.delegationStore.accept({ ...input, mode: "sync" }, parentFence);
      const fence = await fenceFor(child);
      await stores.delegationStore.startExecution(child.id, fence, "child-turn", {}, 4);
      const queued = await stores.delegationStore.accept({ ...input, resume: child.childId, callerToolUseId: "queued-resume" }, parentFence);
      await stores.sessionStore.terminate(child.childId);
      await stores.pendingEventStore.clear(child.childId);
      const reconciled = await stores.delegationStore.reconcileTerminatedExecutions();
      expect(reconciled.map((entry) => entry.id).sort()).toEqual([child.id, queued.id].sort());
      expect(reconciled.every((entry) => entry.status === "interrupted")).toBe(true);
      expect((await stores.delegationStore.getExecution(input.tenantId, queued.id))?.result?.trace.turnId).toBeUndefined();
      expect((await stores.eventLogStore.getEvents(child.childId)).data.filter((entry) => entry.type === "session.turn_aborted")).toHaveLength(1);
      expect((await stores.eventLogStore.getEvents(input.callerSessionId)).data.filter((entry) => entry.type === "subagent.result")).toHaveLength(2);
      expect(await stores.pendingEventStore.count(input.callerSessionId)).toBe(2);
      expect(await stores.delegationStore.reconcileTerminatedExecutions(child.childId)).toEqual([]);
      expect(await stores.delegationStore.hasResourceUsers(input.sandboxSessionId)).toBe(false);
    });
    it("reconciles terminated parents by stopping sync children and cancelling independent async waits", async () => {
      const running = await stores.delegationStore.accept({ ...input, mode: "sync" }, parentFence);
      const runningFence = await fenceFor(running);
      await stores.delegationStore.startExecution(running.id, runningFence, "child-turn", {}, 4);
      const queued = await stores.delegationStore.accept({ ...input, mode: "sync", callerToolUseId: "queued-sync" }, parentFence);
      const asynchronous = await stores.delegationStore.accept({ ...input, callerToolUseId: "independent-async" }, parentFence);
      const asyncFence = await fenceFor(asynchronous);
      await stores.delegationStore.startExecution(asynchronous.id, asyncFence, "async-turn", {}, 4);
      await stores.delegationStore.saveWait({ ...input, callerToolUseId: "wait-async", executionId: asynchronous.id, parentPendingEventId: parentFence.eventId, config: {} }, parentFence);
      await stores.sessionStore.terminate(input.callerSessionId);
      await stores.pendingEventStore.clear(input.callerSessionId);
      const reconciled = await stores.delegationStore.reconcileTerminatedExecutions(input.callerSessionId);
      expect(reconciled.map((entry) => entry.id).sort()).toEqual([running.id, queued.id].sort());
      expect((await stores.delegationStore.getExecution(input.tenantId, queued.id))?.status).toBe("interrupted");
      expect((await stores.delegationStore.getExecution(input.tenantId, asynchronous.id))?.status).toBe("running");
      expect((await stores.delegationStore.listWaits(input.callerSessionId, parentFence.eventId)).every((wait) => wait.status === "cancelled")).toBe(true);
      const commands = await stores.delegationStore.listCommands(running.id);
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({ kind: "interrupt", status: "accepted", targetTurnId: "child-turn" });
      expect(await stores.delegationStore.reconcileTerminatedExecutions()).toEqual([]);
      expect(await stores.delegationStore.listCommands(asynchronous.id)).toEqual([]);
      expect(await stores.pendingEventStore.count(input.callerSessionId)).toBe(0);
    });
    it("retains the shared Sandbox binding for queued children after parent termination", async () => {
      const child = await stores.delegationStore.accept(input, parentFence);
      await stores.sessionStore.terminate(input.callerSessionId);
      expect(await stores.delegationStore.hasResourceUsers(input.sandboxSessionId)).toBe(true);
      await stores.sessionStore.terminate(child.childId);
      expect(await stores.delegationStore.hasResourceUsers(input.sandboxSessionId)).toBe(false);
    });
    it("retains the Sandbox binding between execution admission and Router resource acquisition", async () => {
      const child = await stores.delegationStore.accept(input, parentFence);
      const fence = await fenceFor(child);
      await stores.delegationStore.startExecution(child.id, fence, "child-turn", {}, 4);
      await stores.sessionStore.terminate(input.callerSessionId);
      expect(await stores.delegationStore.hasResourceUsers(input.sandboxSessionId)).toBe(true);
    });
    it("retains independent child resource use after parent release and serializes Sandbox bindings", async () => {
      const child = await stores.delegationStore.accept(input, parentFence); const fence = await fenceFor(child);
      await stores.delegationStore.startExecution(child.id, fence, "child-turn", {}, 4);
      await stores.delegationStore.acquireResourceUse(input.callerSessionId, input.sandboxSessionId, parentFence);
      await stores.delegationStore.acquireResourceUse(child.childId, input.sandboxSessionId, fence);
      await stores.delegationStore.releaseResourceUse(input.callerSessionId, parentFence);
      expect(await stores.delegationStore.hasResourceUsers(input.sandboxSessionId)).toBe(true);
      await finish(child, fence);
      await stores.delegationStore.releaseResourceUse(child.childId, fence);
      expect(await stores.delegationStore.hasResourceUsers(input.sandboxSessionId)).toBe(false);
      await stores.delegationStore.withBindingLock("binding", async ({ sandboxId }) => { expect(sandboxId).toBeNull(); return { next: { ready: "sandbox-1" }, value: 1 }; });
      expect(await stores.delegationStore.withBindingLock("binding", async ({ sandboxId }) => ({ value: sandboxId }))).toBe("sandbox-1");
    });
    it("records a creation intent with the database clock and ends it by Ready or Cold (ADR-0023)", async () => {
      const store = stores.delegationStore;
      const read = () => store.withBindingLock("intent", async (binding) => ({ value: binding }));
      const cold = await read();
      expect(cold).toMatchObject({ sandboxId: null, creatingSince: null });
      await store.withBindingLock("intent", async () => ({ next: "creating", value: undefined }));
      const creating = await read();
      expect(creating.sandboxId).toBeNull();
      // now() when the intent committed: after the read that decided it, not after a later read.
      expect(creating.creatingSince!.getTime()).toBeGreaterThanOrEqual(cold.now.getTime());
      expect(creating.creatingSince!.getTime()).toBeLessThanOrEqual(creating.now.getTime());
      // A callback that names no move keeps the intent, and one that throws moves nothing.
      expect(await store.withBindingLock("intent", async ({ creatingSince }) => ({ value: creatingSince }))).toEqual(creating.creatingSince);
      await expect(store.withBindingLock("intent", async () => { throw new Error("gateway unavailable"); })).rejects.toThrow("gateway unavailable");
      expect(await read()).toMatchObject({ sandboxId: null, creatingSince: creating.creatingSince });
      await store.withBindingLock("intent", async () => ({ next: { ready: "sandbox-1" }, value: undefined }));
      expect(await read()).toMatchObject({ sandboxId: "sandbox-1", creatingSince: null });
      await store.withBindingLock("intent", async () => ({ next: "creating", value: undefined }));
      await store.withBindingLock("intent", async () => ({ next: "cold", value: undefined }));
      expect(await read()).toMatchObject({ sandboxId: null, creatingSince: null });
    });
    it("records the Environment and image a binding's Sandbox was created with, and only with it (ADR-0024)", async () => {
      const store = stores.delegationStore;
      const read = () => store.withBindingLock("origin", async (binding) => ({ value: binding }));
      const image = "registry.example/welltop/oma-environments@sha256:" + "a".repeat(64);
      expect(await read()).toMatchObject({ sandboxId: null, environmentId: null, image: null });
      await store.withBindingLock("origin", async () => ({ next: "creating", value: undefined }));
      expect(await read()).toMatchObject({ environmentId: null, image: null });
      await store.withBindingLock("origin", async () => ({ next: { ready: "sandbox-1", environmentId: "env_a", image }, value: undefined }));
      expect(await read()).toMatchObject({ sandboxId: "sandbox-1", environmentId: "env_a", image });
      // Observations and reads leave it; any move replaces it.
      await store.withBindingLock("origin", async () => ({ value: undefined, observed: "ready" }));
      expect(await read()).toMatchObject({ sandboxId: "sandbox-1", environmentId: "env_a", image });
      await store.withBindingLock("origin", async () => ({ next: "cold", value: undefined }));
      expect(await read()).toMatchObject({ sandboxId: null, environmentId: null, image: null });
      // A Sandbox without an Environment, then one adopted with nothing known.
      await store.withBindingLock("origin", async () => ({ next: { ready: "sandbox-2", environmentId: null, image }, value: undefined }));
      expect(await read()).toMatchObject({ sandboxId: "sandbox-2", environmentId: null, image });
      await store.withBindingLock("origin", async () => ({ next: { ready: "sandbox-3" }, value: undefined }));
      expect(await read()).toMatchObject({ sandboxId: "sandbox-3", environmentId: null, image: null });
    });
    it("reports a binding's Sandbox from its row: cold, creating, ready and unavailable (ADR-0023)", async () => {
      const store = stores.delegationStore;
      const now = async () => (await store.withBindingLock("reported", async ({ now: at }) => ({ value: at }))).getTime();
      const observe = (observed: SandboxObservation, next?: BindingTransition) =>
        store.withBindingLock("reported", async () => ({ value: undefined, next, observed }));
      const failure = (reason: string) => ({ failure: { code: "sandbox_unavailable", reason } });
      // Never used: Cold since nothing recorded.
      expect(await store.sandbox("reported")).toEqual({ state: "cold", since: null, lastError: null });
      await store.withBindingLock("reported", async () => ({ next: "creating", value: undefined }));
      const { creatingSince } = await store.withBindingLock("reported", async (binding) => ({ value: binding }));
      expect(await store.sandbox("reported")).toEqual({ state: "creating", since: creatingSince, lastError: null });

      const beforeReady = await now();
      await store.withBindingLock("reported", async () => ({ next: { ready: "sandbox-1" }, value: undefined }));
      const ready = await store.sandbox("reported");
      expect(ready).toMatchObject({ state: "ready", lastError: null });
      expect(ready.since!.getTime()).toBeGreaterThanOrEqual(beforeReady);
      expect(ready.since!.getTime()).toBeLessThanOrEqual(await now());

      // A failure: unavailable since it was recorded, with its code, reason and time.
      const beforeFailure = await now();
      await observe(failure("mount"));
      const failed = await store.sandbox("reported");
      expect(failed).toMatchObject({ state: "unavailable", lastError: { code: "sandbox_unavailable", reason: "mount" } });
      expect(failed.lastError!.at.getTime()).toBeGreaterThanOrEqual(beforeFailure);
      expect(failed.since).toEqual(failed.lastError!.at);
      // Another one: the latest is reported, unavailable since the first.
      await observe(failure("unreachable"));
      const again = await store.sandbox("reported");
      expect(again).toMatchObject({ state: "unavailable", since: failed.since, lastError: { reason: "unreachable" } });
      expect(again.lastError!.at.getTime()).toBeGreaterThanOrEqual(failed.lastError!.at.getTime());

      // A preparation that ends ready clears it: ready since the recovery.
      await observe("ready");
      const recovered = await store.sandbox("reported");
      expect(recovered).toMatchObject({ state: "ready", lastError: null });
      expect(recovered.since!.getTime()).toBeGreaterThanOrEqual(again.lastError!.at.getTime());
      // With nothing to clear, it changes nothing.
      await observe("ready");
      expect(await store.sandbox("reported")).toEqual(recovered);

      // A move begins a new state, which the old state's failure says nothing about.
      await observe(failure("unreachable"));
      const beforeCold = await now();
      await store.withBindingLock("reported", async () => ({ next: "cold", value: undefined }));
      const cold = await store.sandbox("reported");
      expect(cold).toMatchObject({ state: "cold", lastError: null });
      expect(cold.since!.getTime()).toBeGreaterThanOrEqual(beforeCold);
      // A failure recorded with a move belongs to the new state.
      await store.withBindingLock("reported", async () => ({ next: "creating", value: undefined }));
      await observe(failure("rejected"), "cold");
      const rejected = await store.sandbox("reported");
      expect(rejected).toMatchObject({ state: "unavailable", lastError: { reason: "rejected" } });
      expect(rejected.since).toEqual(rejected.lastError!.at);
      expect(await store.withBindingLock("reported", async (binding) => ({ value: binding }))).toMatchObject({ sandboxId: null, creatingSince: null });
      // A callback that throws records nothing.
      await expect(store.withBindingLock("reported", async () => { throw new Error("gateway unavailable"); })).rejects.toThrow();
      expect(await store.sandbox("reported")).toEqual(rejected);
      expect(await store.sandbox("other-binding")).toEqual({ state: "cold", since: null, lastError: null });
    });
    it("records a Skill Install only while the binding still holds the Sandbox it went into", async () => {
      const store = stores.delegationStore;
      const [first, second] = ["a".repeat(64), "b".repeat(64)];
      expect(await store.installedSkillSet("skills-binding")).toBeNull();
      // Nothing is bound yet: there is no Sandbox an install could have gone into.
      expect(await store.recordSkillSetInstall("skills-binding", { sandboxId: "sandbox-1", setHash: first, generation: 1 })).toBe("detached");
      await store.withBindingLock("skills-binding", async () => ({ next: { ready: "sandbox-1" }, value: undefined }));
      expect(await store.installedSkillSet("skills-binding")).toBeNull();
      expect(await store.recordSkillSetInstall("skills-binding", { sandboxId: "sandbox-1", setHash: first, generation: 1 })).toBe("recorded");
      expect(await store.installedSkillSet("skills-binding")).toEqual({ sandboxId: "sandbox-1", setHash: first, generation: 1 });
      // A record is not part of the binding operation's compare-and-set.
      expect(await store.withBindingLock("skills-binding", async ({ sandboxId }) => {
        expect(await store.recordSkillSetInstall("skills-binding", { sandboxId: "sandbox-1", setHash: second, generation: 2 })).toBe("recorded");
        return { next: { ready: sandboxId! }, value: sandboxId };
      })).toBe("sandbox-1");
      expect(await store.installedSkillSet("skills-binding")).toEqual({ sandboxId: "sandbox-1", setHash: second, generation: 2 });
      // A rebuilt binding keeps the old record, naming the old Sandbox: the
      // new Sandbox never inherits it, and a late install into the old one is refused.
      await store.withBindingLock("skills-binding", async () => ({ next: { ready: "sandbox-2" }, value: undefined }));
      expect(await store.installedSkillSet("skills-binding")).toEqual({ sandboxId: "sandbox-1", setHash: second, generation: 2 });
      expect(await store.recordSkillSetInstall("skills-binding", { sandboxId: "sandbox-1", setHash: first, generation: 3 })).toBe("detached");
      // Generations count switches per Sandbox: a new Sandbox starts again.
      expect(await store.recordSkillSetInstall("skills-binding", { sandboxId: "sandbox-2", setHash: first, generation: 1 })).toBe("recorded");
      expect(await store.installedSkillSet("skills-binding")).toEqual({ sandboxId: "sandbox-2", setHash: first, generation: 1 });
      await store.withBindingLock("skills-binding", async () => ({ next: "cold", value: undefined }));
      expect(await store.recordSkillSetInstall("skills-binding", { sandboxId: "sandbox-2", setHash: second, generation: 2 })).toBe("detached");
      expect(await store.installedSkillSet("other-binding")).toBeNull();
    });
    it("keeps the latest switch when installs into one Sandbox record out of order", async () => {
      const store = stores.delegationStore;
      const [x, y] = ["c".repeat(64), "d".repeat(64)];
      await store.withBindingLock("racing-binding", async () => ({ next: { ready: "sandbox-1" }, value: undefined }));
      // Y switched first (generation 1), X after it (generation 2), but X records first.
      expect(await store.recordSkillSetInstall("racing-binding", { sandboxId: "sandbox-1", setHash: x, generation: 2 })).toBe("recorded");
      expect(await store.recordSkillSetInstall("racing-binding", { sandboxId: "sandbox-1", setHash: y, generation: 1 })).toBe("superseded");
      expect(await store.installedSkillSet("racing-binding")).toEqual({ sandboxId: "sandbox-1", setHash: x, generation: 2 });
      // A repeated record of a recorded switch changes nothing.
      expect(await store.recordSkillSetInstall("racing-binding", { sandboxId: "sandbox-1", setHash: y, generation: 2 })).toBe("superseded");
      expect(await store.recordSkillSetInstall("racing-binding", { sandboxId: "sandbox-1", setHash: y, generation: 3 })).toBe("recorded");
      expect(await store.installedSkillSet("racing-binding")).toEqual({ sandboxId: "sandbox-1", setHash: y, generation: 3 });
    });
  });
}
