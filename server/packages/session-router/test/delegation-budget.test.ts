import { describe, expect, it } from "vitest";
import { createMemoryStores } from "@oma-server/store-memory";
import { DelegationCoordinator } from "../src/delegation-coordinator.js";

describe("Host delegation budget", () => {
  it.each([7, 500, 1000])("assigns the Host budget of %i to create and resume", async (maximum) => {
    const stores = createMemoryStores();
    const agent = await stores.agentStore.create({ tenantId: "tenant", name: "Agent", model: "test", system: "test", runtime: "pi-agent", sandbox: { enabled: true } });
    const workspace = await stores.workspaceStore.create({ tenantId: "tenant" });
    const parent = await stores.sessionStore.create({ tenantId: "tenant", agentId: agent.id, agent, workspaceId: workspace.id });
    const input = await stores.pendingEventStore.enqueue(parent.id, { type: "user.message", data: {}, sessionThreadId: "sthr_primary" });
    const claim = await stores.pendingEventStore.claim(parent.id, "host", 30_000);
    const coordinator = new DelegationCoordinator({
      store: stores.delegationStore, pending: stores.pendingEventStore,
      sessions: stores.sessionStore, events: stores.eventLogStore,
      wake() {}, publish() {}, maxSteps: maximum,
    });
    const capability = coordinator.capability({ session: parent, turnId: "turn", fence: { eventId: input.id, ...claim! }, signal: new AbortController().signal, effectiveConfig: { model: "provider/parent" } });
    expect(capability.maxModelSteps).toBe(maximum);
    const override = { prompt: "task", runInBackground: true, model: "untrusted/different-model" };
    await expect(capability.delegate(override, { toolUseId: "model-override", checkpoint: [] }))
      .rejects.toThrow("Delegated model overrides are not supported");

    // Bypass Pi validation: the Host must independently reject budget overrides.
    for (const key of ["maxSteps", "max_steps"]) {
      const override = { prompt: "task", runInBackground: true, [key]: 6 };
      await expect(capability.delegate(override, { toolUseId: key, checkpoint: [] }))
        .rejects.toThrow("Delegated budget overrides are not supported");
    }
    expect(await stores.delegationStore.list("tenant", parent.id)).toEqual([]);
    await capability.delegate({ prompt: "task", runInBackground: true }, { toolUseId: "default", checkpoint: [] });
    const initial = (await stores.delegationStore.list("tenant", parent.id))[0];
    await capability.delegate({ prompt: "continue", runInBackground: true, resume: initial.childId }, { toolUseId: "resume", checkpoint: [] });
    const executions = await stores.delegationStore.list("tenant", parent.id);
    expect(executions).toHaveLength(2);
    expect(executions.every(execution => execution.maxSteps === maximum && execution.childId === initial.childId)).toBe(true);
  });
});
