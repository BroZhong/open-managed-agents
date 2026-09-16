import { describe, it, expect, beforeEach, afterAll } from "vitest";
import type { WorkspaceMetadataStore, AgentStore, SessionStore, PendingEventStore, EventLogStore, DelegationStore, DelegationAcceptInput, PendingEventFence, DelegationExecution } from "../src/index.js";
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
    it("keeps sync wait bound to exact execution and never queues automatic callback", async () => {
      const child = await stores.delegationStore.accept({ ...input, mode: "sync" }, parentFence);
      const wait = await stores.delegationStore.saveWait({ ...input, executionId: child.id, parentPendingEventId: parentFence.eventId, checkpoint: { turnId: "parent-turn", tools: ["already-done"] } }, parentFence);
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
    it("turns lost-owner running execution into recovery_required instead of replaying output", async () => {
      const child = await stores.delegationStore.accept(input, parentFence);
      const oldFence = await fenceFor(child);
      await stores.delegationStore.startExecution(child.id, oldFence, "child-turn", {}, 4);
      await stores.pendingEventStore.releaseClaim!(child.childId, oldFence.eventId, oldFence);
      const newFence = await fenceFor(child, "replacement");
      await expect(finish(child, oldFence)).rejects.toThrow();
      const recovered = await stores.delegationStore.startExecution(child.id, newFence, "new-turn-must-not-run", {}, 4);
      expect(recovered).toMatchObject({ status: "recovery_required", turnId: "child-turn", result: { output: "" } });
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
      await stores.delegationStore.saveWait({ ...input, callerToolUseId: "wait-async", executionId: asynchronous.id, parentPendingEventId: parentFence.eventId, checkpoint: {} }, parentFence);
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
    it("retains the shared environment for queued children after parent termination", async () => {
      const child = await stores.delegationStore.accept(input, parentFence);
      await stores.sessionStore.terminate(input.callerSessionId);
      expect(await stores.delegationStore.hasResourceUsers(input.sandboxSessionId)).toBe(true);
      await stores.sessionStore.terminate(child.childId);
      expect(await stores.delegationStore.hasResourceUsers(input.sandboxSessionId)).toBe(false);
    });
    it("retains the environment between execution admission and Router resource acquisition", async () => {
      const child = await stores.delegationStore.accept(input, parentFence);
      const fence = await fenceFor(child);
      await stores.delegationStore.startExecution(child.id, fence, "child-turn", {}, 4);
      await stores.sessionStore.terminate(input.callerSessionId);
      expect(await stores.delegationStore.hasResourceUsers(input.sandboxSessionId)).toBe(true);
    });
    it("retains independent child resource use after parent release and serializes environment bindings", async () => {
      const child = await stores.delegationStore.accept(input, parentFence); const fence = await fenceFor(child);
      await stores.delegationStore.startExecution(child.id, fence, "child-turn", {}, 4);
      await stores.delegationStore.acquireResourceUse(input.callerSessionId, input.sandboxSessionId, parentFence);
      await stores.delegationStore.acquireResourceUse(child.childId, input.sandboxSessionId, fence);
      await stores.delegationStore.releaseResourceUse(input.callerSessionId, parentFence);
      expect(await stores.delegationStore.hasResourceUsers(input.sandboxSessionId)).toBe(true);
      await finish(child, fence);
      await stores.delegationStore.releaseResourceUse(child.childId, fence);
      expect(await stores.delegationStore.hasResourceUsers(input.sandboxSessionId)).toBe(false);
      await stores.delegationStore.withEnvironmentLock("binding", async (existing) => { expect(existing).toBeNull(); return { sandboxId: "sandbox-1", value: 1 }; });
      expect(await stores.delegationStore.withEnvironmentLock("binding", async (existing) => ({ sandboxId: existing, value: existing }))).toBe("sandbox-1");
    });
  });
}
