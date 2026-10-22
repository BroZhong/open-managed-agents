import { describe, expect, it, vi } from "vitest";
import { createMemoryStores } from "../src/index.js";
import { delegationContract } from "../../store/test/delegation-contract.js";
delegationContract("Memory delegation lifecycle", async () => createMemoryStores());

describe("Memory delegation transactions", () => {
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
