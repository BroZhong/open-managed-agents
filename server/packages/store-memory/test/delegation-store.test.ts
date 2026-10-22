import { describe, expect, it, vi } from "vitest";
import type { PendingEvent, PendingEventClaim, StoredEvent } from "@oma-server/store";
import { createMemoryStores } from "../src/index.js";
import { delegationContract } from "../../store/test/delegation-contract.js";
delegationContract("Memory delegation lifecycle", async () => createMemoryStores());

describe("Memory delegation transactions", () => {
  const message = { type: "user.message", data: {}, sessionThreadId: "sthr_primary" };
  /** A parent Session whose Turn holds its input, and an unrelated Session another writer works on. */
  const setUp = async () => {
    const stores = createMemoryStores();
    const agent = await stores.agentStore.create({ tenantId: "tenant-a", name: "Agent", model: "model", system: "system", runtime: "pi-agent" });
    const parent = await stores.sessionStore.create({ tenantId: "tenant-a", agentId: agent.id, agent, workspaceId: "workspace" });
    const other = await stores.sessionStore.create({ tenantId: "tenant-a", agentId: agent.id, agent, workspaceId: "workspace" });
    await stores.pendingEventStore.enqueue(parent.id, message);
    const claim = (await stores.pendingEventStore.claim(parent.id, "parent-owner", 60_000))!;
    const fence = { eventId: claim.event.id, ownerId: claim.ownerId, generation: claim.generation };
    const input = { tenantId: "tenant-a", callerSessionId: parent.id, callerTurnId: "turn", callerToolUseId: "tool",
      prompt: "Do task", mode: "sync" as const, parentModel: "provider/model", maxSteps: 30, sandboxSessionId: parent.id };
    return { stores, agent, parent, other, fence, input };
  };

  it("a transaction that wrote and then failed undoes its own writes and keeps those another writer committed meanwhile", async () => {
    const { stores, agent, parent, other, fence, input } = await setUp();
    await stores.pendingEventStore.enqueue(other.id, message);
    const enqueue = stores.pendingEventStore.enqueue.bind(stores.pendingEventStore);
    const concurrent: { sessionId?: string; claim?: PendingEventClaim } = {};
    // The Child Session is written; while another writer commits its own work,
    // the transaction fails before the child's input lands.
    vi.spyOn(stores.pendingEventStore, "enqueue").mockImplementationOnce(async () => {
      concurrent.sessionId = (await stores.sessionStore.create({ tenantId: "tenant-a", agentId: agent.id, agent, workspaceId: "workspace" })).id;
      await enqueue(other.id, message);
      concurrent.claim = (await stores.pendingEventStore.claim(other.id, "other-owner", 60_000))!;
      await stores.eventLogStore.append(other.id, { type: "session.turn_aborted", data: { turnId: "other-turn" }, sessionThreadId: "sthr_primary" });
      throw new Error("store unavailable");
    });
    await expect(stores.delegationStore.accept(input, fence)).rejects.toThrow("store unavailable");

    expect((await stores.sessionStore.list("tenant-a")).data.map((session) => session.id).sort())
      .toEqual([parent.id, other.id, concurrent.sessionId].sort());
    expect(await stores.delegationStore.list("tenant-a", parent.id)).toEqual([]);
    expect(await stores.pendingEventStore.count(other.id)).toBe(2);
    expect(await stores.pendingEventStore.ownsClaim(other.id, concurrent.claim!.event.id, concurrent.claim!)).toBe(true);
    expect((await stores.eventLogStore.getEvents(other.id)).data.map((event) => event.type)).toEqual(["session.turn_aborted"]);
    // Nothing of the failed attempt is in the way of a retry.
    const accepted = await stores.delegationStore.accept(input, fence);
    expect(await stores.pendingEventStore.count(accepted.childId)).toBe(1);
    expect(await stores.delegationStore.listWaits(parent.id, fence.eventId)).toHaveLength(1);
  });

  it("a transaction that wrote and then failed keeps what another writer committed to the same queues and logs", async () => {
    const { stores, parent, fence, input } = await setUp();
    const executions = [];
    for (const callerToolUseId of ["tool-1", "tool-2"]) {
      const execution = await stores.delegationStore.accept({ ...input, mode: "async", callerToolUseId }, fence);
      const claim = (await stores.pendingEventStore.claim(execution.childId, "child-owner", 60_000))!;
      const childFence = { eventId: claim.event.id, ownerId: claim.ownerId, generation: claim.generation };
      await stores.delegationStore.startExecution(execution.id, childFence, `turn-${callerToolUseId}`, {}, 4);
      await stores.sessionStore.terminate(execution.childId);
      executions.push({ execution, fence: childFence });
    }
    const [first, second] = executions;
    const enqueue = stores.pendingEventStore.enqueue.bind(stores.pendingEventStore);
    const getById = stores.sessionStore.getById.bind(stores.sessionStore);
    const types = async (sessionId: string) => (await stores.eventLogStore.getEvents(sessionId)).data.map((event) => event.type);
    let concurrent: { parentEvent: StoredEvent; parentInput: PendingEvent } | undefined;
    // The first child's outcome is written: its Turn aborted, its input taken,
    // its result and notification delivered to the parent. Before the second,
    // other writers commit to those same logs and queues; then it fails.
    vi.spyOn(stores.sessionStore, "getById").mockImplementation(async (id) => {
      if (id === second.execution.childId && !concurrent && (await types(parent.id)).includes("subagent.result")) {
        concurrent = {
          parentEvent: await stores.eventLogStore.append(parent.id, { type: "agent.message", data: { content: [] }, sessionThreadId: "sthr_primary", pendingFence: fence }),
          parentInput: await enqueue(parent.id, message),
        };
        await stores.eventLogStore.append(first.execution.childId, { type: "session.turn_aborted", data: { turnId: "other-router" }, sessionThreadId: "sthr_primary" });
        await enqueue(first.execution.childId, message);
        throw new Error("store unavailable");
      }
      return getById(id);
    });
    await expect(stores.delegationStore.reconcileTerminatedExecutions()).rejects.toThrow("store unavailable");

    expect(await types(parent.id)).toEqual(["agent.message"]);
    expect((await stores.pendingEventStore.listUnclaimed(parent.id, 10)).map((pending) => pending.id)).toEqual([concurrent!.parentInput.id]);
    expect(await stores.pendingEventStore.ownsClaim(parent.id, fence.eventId, fence)).toBe(true);
    expect(await types(first.execution.childId)).toEqual(["session.turn_aborted"]);
    expect((await stores.eventLogStore.getEvents(first.execution.childId)).data[0].data).toEqual({ turnId: "other-router" });
    // The child's input is back ahead of the one queued after it, still claimed.
    expect(await stores.pendingEventStore.count(first.execution.childId)).toBe(2);
    expect(await stores.pendingEventStore.ownsClaim(first.execution.childId, first.fence.eventId, first.fence)).toBe(true);
    expect((await stores.delegationStore.getExecution("tenant-a", first.execution.id))?.status).toBe("running");

    // The retry finds the first child as it was and does all of it once.
    expect((await stores.delegationStore.reconcileTerminatedExecutions()).map((execution) => execution.status)).toEqual(["interrupted", "interrupted"]);
    const parentLog = (await stores.eventLogStore.getEvents(parent.id)).data;
    expect(parentLog.map((event) => event.type)).toEqual(["agent.message", "subagent.result", "subagent.result"]);
    // Sequence numbers are not handed out again: the result follows the other writer's event.
    expect(parentLog[1].seq).toBeGreaterThan(concurrent!.parentEvent.seq);
    expect(await types(first.execution.childId)).toEqual(["session.turn_aborted", "session.turn_aborted"]);
    expect(await stores.pendingEventStore.count(first.execution.childId)).toBe(1);
    expect(await stores.pendingEventStore.count(parent.id)).toBe(4);
  });

  it("a transaction that fails its fence undoes nothing another writer did while it ran", async () => {
    const stores = createMemoryStores();
    const agent = await stores.agentStore.create({ tenantId: "tenant-a", name: "Agent", model: "model", system: "system", runtime: "pi-agent" });
    const parent = await stores.sessionStore.create({ tenantId: "tenant-a", agentId: agent.id, agent, workspaceId: "workspace" });
    const other = await stores.sessionStore.create({ tenantId: "tenant-a", agentId: agent.id, agent, workspaceId: "workspace" });
    await stores.pendingEventStore.enqueue(parent.id, { type: "user.message", data: {}, sessionThreadId: "sthr_primary" });
    const claim = (await stores.pendingEventStore.claim(parent.id, "lost-owner", 60_000))!;
    const fence = { eventId: claim.event.id, ownerId: claim.ownerId, generation: claim.generation };
    // The claim's owner lost it before its delegation reached the store.
    await stores.pendingEventStore.releaseClaim(parent.id, fence.eventId, fence);
    // While the transaction checks the fence, another writer queues an input.
    const getById = stores.sessionStore.getById.bind(stores.sessionStore);
    let queued = false;
    vi.spyOn(stores.sessionStore, "getById").mockImplementation(async (id) => {
      if (!queued) { queued = true; await stores.pendingEventStore.enqueue(other.id, { type: "user.message", data: {}, sessionThreadId: "sthr_primary" }); }
      return getById(id);
    });
    await expect(stores.delegationStore.accept({ tenantId: "tenant-a", callerSessionId: parent.id, callerTurnId: "turn", callerToolUseId: "tool",
      prompt: "Do task", mode: "sync", parentModel: "provider/model", maxSteps: 30, sandboxSessionId: parent.id }, fence)).rejects.toThrow();
    expect(queued).toBe(true);
    expect(await stores.pendingEventStore.count(other.id)).toBe(1);
  });
});
