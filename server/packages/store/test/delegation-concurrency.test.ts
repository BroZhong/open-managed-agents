import { describe, beforeEach, afterAll, it, expect } from "vitest";
import { createPgStores, PgDelegationStore, type DelegationAcceptInput, type PendingEventFence, type DelegationExecution, type PgStores } from "../src/index.js";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";

describe.skipIf(!process.env.PG_TEST_URL)("Delegation transactions on real PostgreSQL", () => {
  let harness: PgTestHarness;
  let stores: PgStores;
  let caller: DelegationAcceptInput;
  let parentFence: PendingEventFence;
  beforeEach(async () => {
    if (!harness) harness = await createPgTestHarness(); else await harness.reset();
    stores = await createPgStores(harness.pool, { ensureSchema: false });
    const agent = await stores.agentStore.create({ tenantId: "tenant", name: "agent", system: "", model: "model", runtime: "pi" });
    const parent = await stores.sessionStore.create({ tenantId: "tenant", agentId: agent.id, agent, workspaceId: "workspace" });
    await stores.pendingEventStore.enqueue(parent.id, { type: "user.message", data: {}, sessionThreadId: "sthr_primary" });
    const claim = (await stores.pendingEventStore.claim(parent.id, "parent", 60000))!;
    parentFence = { eventId: claim.event.id, ownerId: claim.ownerId, generation: claim.generation };
    caller = { tenantId: "tenant", callerSessionId: parent.id, callerTurnId: "parent-turn", callerToolUseId: "tool", mode: "async", prompt: "task", parentModel: "provider/parent-model", maxSteps: 30, sandboxSessionId: parent.id };
  });
  afterAll(async () => { await harness?.close(); });
  async function start(child: DelegationExecution) {
    const claim = (await stores.pendingEventStore.claim(child.childId, "child", 60000))!;
    const fence = { eventId: claim.event.id, ownerId: claim.ownerId, generation: claim.generation };
    await stores.delegationStore.startExecution(child.id, fence, "child-turn", {}, 4);
    return fence;
  }
  const outcome = (child: DelegationExecution) => ({ status: "completed" as const, reason: "finished", output: "done", trace: { sessionId: child.childId, turnId: "child-turn" } });
  it("serializes acceptance across independent store instances and admits only quota slots", async () => {
    const other = new PgDelegationStore(harness.pool);
    const accepted = await Promise.all([stores.delegationStore.accept(caller, parentFence), other.accept(caller, parentFence), other.accept(caller, parentFence)]);
    expect(new Set(accepted.map((row) => row.id)).size).toBe(1);
    expect((await stores.sessionStore.list("tenant", { limit: 100 })).data).toHaveLength(2);
    const two = await other.accept({ ...caller, callerToolUseId: "second" }, parentFence);
    const claims = await Promise.all([accepted[0], two].map(async (child) => {
      const claim = (await stores.pendingEventStore.claim(child.childId, "owner", 60000))!;
      return { child, fence: { eventId: claim.event.id, ownerId: claim.ownerId, generation: claim.generation } };
    }));
    const started = await Promise.all(claims.map(({ child, fence }) => other.startExecution(child.id, fence, "turn", {}, 1)));
    expect(started.filter(Boolean)).toHaveLength(1);
  });
  it("rolls back terminal plus parent event when pending callback insert fails", async () => {
    const child = await stores.delegationStore.accept(caller, parentFence); const fence = await start(child);
    await harness.pool.query(`CREATE FUNCTION reject_callback() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type = 'subagent.result' THEN RAISE EXCEPTION 'injected callback failure'; END IF; RETURN NEW; END $$`);
    await harness.pool.query("CREATE TRIGGER reject_callback BEFORE INSERT ON pending_events FOR EACH ROW EXECUTE FUNCTION reject_callback()");
    await expect(stores.delegationStore.finishExecution(child.id, fence, outcome(child))).rejects.toThrow("injected callback failure");
    expect((await stores.delegationStore.getExecution("tenant", child.id))?.status).toBe("running");
    expect((await stores.eventLogStore.getEvents(caller.callerSessionId)).data).toHaveLength(0);
    expect(await stores.pendingEventStore.count(caller.callerSessionId)).toBe(1);
    await harness.pool.query("DROP TRIGGER reject_callback ON pending_events");
    expect((await stores.delegationStore.finishExecution(child.id, fence, outcome(child))).status).toBe("completed");
  });
  it("orders parent termination with result publication and retains the result without waking", async () => {
    const child = await stores.delegationStore.accept(caller, parentFence); const fence = await start(child);
    await Promise.all([stores.delegationStore.finishExecution(child.id, fence, outcome(child)), stores.sessionStore.terminate(caller.callerSessionId)]);
    expect((await stores.delegationStore.getExecution("tenant", child.id))?.status).toBe("completed");
    expect((await stores.eventLogStore.getEvents(caller.callerSessionId)).data.filter((event) => event.type === "subagent.result")).toHaveLength(1);
    expect(await stores.pendingEventStore.count(caller.callerSessionId)).toBe(0);
  });
  it("rejects an expired owner at commit and resolves the abandoned running execution without replay", async () => {
    const child = await stores.delegationStore.accept(caller, parentFence); const oldFence = await start(child);
    await harness.pool.query("UPDATE pending_events SET claim_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [child.pendingEventId]);
    const claim = (await stores.pendingEventStore.claim(child.childId, "new-owner", 60000))!;
    const newFence = { eventId: claim.event.id, ownerId: claim.ownerId, generation: claim.generation };
    await expect(stores.delegationStore.finishExecution(child.id, oldFence, outcome(child))).rejects.toThrow();
    expect((await stores.delegationStore.startExecution(child.id, newFence, "unused", {}, 4))?.status).toBe("recovery_required");
    expect((await stores.pendingEventStore.listUnclaimed(caller.callerSessionId, 10)).filter((event) => event.type === "subagent.result")).toHaveLength(1);
  });
});
