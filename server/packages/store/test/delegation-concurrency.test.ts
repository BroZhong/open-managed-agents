import { describe, beforeEach, afterAll, it, expect } from "vitest";
import { createPgStores, PgDelegationStore, DelegationLimitReached, type DelegationAcceptInput, type PendingEventFence, type DelegationExecution, type PgStores } from "../src/index.js";
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
    caller = { tenantId: "tenant", callerSessionId: parent.id, callerTurnId: "parent-turn", callerToolUseId: "tool", mode: "async", prompt: "task", parentModel: "provider/parent-model", maxSteps: 30, maxConcurrent: 4, sandboxSessionId: parent.id };
  });
  afterAll(async () => { await harness?.close(); });
  async function start(child: DelegationExecution) {
    const claim = (await stores.pendingEventStore.claim(child.childId, "child", 60000))!;
    const fence = { eventId: claim.event.id, ownerId: claim.ownerId, generation: claim.generation };
    await stores.delegationStore.startExecution(child.id, fence, "child-turn", {});
    return fence;
  }
  const outcome = (child: DelegationExecution) => ({ status: "completed" as const, reason: "finished", output: "done", trace: { sessionId: child.childId, turnId: "child-turn" } });
  /** Another Delegation Family in the same Tenant and Workspace: a parent with its claimed input. */
  async function family(name: string) {
    const agent = (await stores.agentStore.list("tenant")).data[0];
    const parent = await stores.sessionStore.create({ tenantId: "tenant", agentId: agent.id, agent, workspaceId: "workspace" });
    await stores.pendingEventStore.enqueue(parent.id, { type: "user.message", data: {}, sessionThreadId: "sthr_primary" });
    const claim = (await stores.pendingEventStore.claim(parent.id, name, 60000))!;
    const fence: PendingEventFence = { eventId: claim.event.id, ownerId: claim.ownerId, generation: claim.generation };
    return { parent, fence, caller: { ...caller, callerSessionId: parent.id, sandboxSessionId: parent.id } };
  }
  /** Settles within `ms`, or reports it still waits. */
  const within = <T>(promise: Promise<T>, ms = 1_000) => Promise.race([promise.then(() => "settled"), new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), ms))]);
  it("orders new child admission after a concurrent Workspace soft deletion commits", async () => {
    await stores.workspaceStore.create({ tenantId: caller.tenantId, id: "workspace" });
    const deletion = await harness.pool.connect();
    try {
      await deletion.query("BEGIN");
      await deletion.query("UPDATE workspaces SET deleted_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2", [caller.tenantId, "workspace"]);
      let settled = false;
      const admission = stores.delegationStore.accept(caller, parentFence).then(
        () => { settled = true; return "accepted"; },
        (error: Error) => { settled = true; return error.message; },
      );
      try {
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(settled).toBe(false);
      } finally { await deletion.query("COMMIT"); }
      expect(await admission).toBe("Workspace has been deleted");
      expect((await stores.sessionStore.list(caller.tenantId)).data).toHaveLength(1);
      expect(await stores.delegationStore.list(caller.tenantId, caller.callerSessionId)).toEqual([]);
    } finally { await deletion.query("ROLLBACK"); deletion.release(); }
  });
  it("serializes a family's acceptance across independent store instances under its lock and admits only the parent's limit (ADR-0027)", async () => {
    const other = new PgDelegationStore(harness.pool);
    const accepted = await Promise.all([stores.delegationStore.accept(caller, parentFence), other.accept(caller, parentFence), other.accept(caller, parentFence)]);
    expect(new Set(accepted.map((row) => row.id)).size).toBe(1);
    expect((await stores.sessionStore.list("tenant", { limit: 100 })).data).toHaveLength(2);
    // Eight different calls race for the three places left of four.
    const calls = Array.from({ length: 8 }, (_, index) => (index % 2 ? other : stores.delegationStore)
      .accept({ ...caller, callerToolUseId: `call-${index}`, mode: index % 3 ? "async" : "sync" }, parentFence)
      .then((execution) => execution.id, (error: Error) => error));
    const outcomes = await Promise.all(calls);
    expect(outcomes.filter((outcome) => typeof outcome === "string")).toHaveLength(3);
    expect(outcomes.filter((outcome) => outcome instanceof DelegationLimitReached)).toHaveLength(5);
    expect(await stores.delegationStore.list("tenant", caller.callerSessionId)).toHaveLength(4);
    expect((await stores.sessionStore.list("tenant", { limit: 100 })).data).toHaveLength(5);
  });
  it("does not make another Delegation Family wait while a transaction holds its family's lock (ADR-0027)", async () => {
    await stores.workspaceStore.create({ tenantId: caller.tenantId, id: "workspace" });
    const other = await family("other");
    const otherChild = await stores.delegationStore.accept(other.caller, other.fence);
    // A transaction of the first family takes its lock, then waits for the
    // parent's row, which a client outside the store holds.
    const blocker = await harness.pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [caller.callerSessionId]);
      const blocked = stores.delegationStore.accept(caller, parentFence);
      await new Promise((resolve) => setTimeout(resolve, 100));
      // The family's own transactions wait for its lock, a reclaimability
      // read too, though it reads no row the blocker holds.
      const sameFamily = stores.delegationStore.hasResourceUsers(caller.callerSessionId);
      expect(await within(sameFamily, 300)).toBe("waiting");
      // Every kind of transaction of the other family proceeds: acceptance
      // (in the same Workspace), start, Sandbox resource use, reclaimability,
      // waits, commands and publication.
      expect(await within(stores.delegationStore.accept({ ...other.caller, callerToolUseId: "second", mode: "sync" }, other.fence))).toBe("settled");
      const childFence = await start(otherChild);
      expect(await within(stores.delegationStore.acquireResourceUse(otherChild.childId, other.parent.id, childFence))).toBe("settled");
      expect(await within(stores.delegationStore.acquireResourceUse(other.parent.id, other.parent.id, other.fence))).toBe("settled");
      expect(await within(stores.delegationStore.hasResourceUsers(other.parent.id))).toBe("settled");
      expect(await within(stores.delegationStore.command({ ...other.caller, callerToolUseId: "steer", childId: otherChild.childId, kind: "steer", message: "go on" }, other.fence))).toBe("settled");
      expect(await within(stores.delegationStore.finishExecution(otherChild.id, childFence, outcome(otherChild)))).toBe("settled");
      expect(await within(stores.delegationStore.releaseResourceUse(other.parent.id, other.fence))).toBe("settled");
      expect(await within(stores.delegationStore.reconcileTerminatedExecutions(other.parent.id))).toBe("settled");
      await blocker.query("COMMIT");
      expect((await blocked).status).toBe("queued");
      expect(await sameFamily).toBe(true);
    } finally { await blocker.query("ROLLBACK").catch(() => {}); blocker.release(); }
  });
  it("publishes before it consumes, once, while many families finish and consume at once", async () => {
    const families = await Promise.all(Array.from({ length: 6 }, (_, index) => family(`parent-${index}`)));
    const runs = await Promise.all(families.map(async ({ caller: own, fence }) => {
      const child = await stores.delegationStore.accept(own, fence);
      const childFence = await start(child);
      const consume = () => stores.delegationStore.consumeResult(child.id, { ...own, callerToolUseId: "tool" }, fence, {
        type: "agent.tool_result", data: { toolUseId: "tool", content: [] }, sessionThreadId: "sthr_primary" });
      // A consumption that runs first finds no published result and is refused.
      const [, early] = await Promise.all([stores.delegationStore.finishExecution(child.id, childFence, outcome(child)),
        consume().then(() => "consumed", (error: Error) => error.message)]);
      if (early !== "consumed") { expect(early).toBe("Delegation result unavailable"); await consume(); }
      return { own, child };
    }));
    for (const { own, child } of runs) {
      const log = (await stores.eventLogStore.getEvents(own.callerSessionId)).data;
      expect(log.filter((event) => event.type === "subagent.result")).toHaveLength(1);
      expect(log.filter((event) => event.type === "agent.tool_result")).toHaveLength(1);
      // The tool consumed the result, so its asynchronous delivery is withdrawn.
      expect(await stores.delegationStore.getExecution("tenant", child.id)).toMatchObject({ status: "completed", notificationStatus: "consumed" });
      expect((await stores.pendingEventStore.listUnclaimed(own.callerSessionId, 10)).filter((event) => event.type === "subagent.result")).toEqual([]);
    }
  });
  it("judges a Sandbox in use under its family's lock while a child starts and its parent releases", async () => {
    const families = await Promise.all(Array.from({ length: 6 }, (_, index) => family(`binding-${index}`)));
    await Promise.all(families.map(async ({ parent, caller: own, fence }) => {
      await stores.delegationStore.acquireResourceUse(parent.id, parent.id, fence);
      const child = await stores.delegationStore.accept(own, fence);
      const claim = (await stores.pendingEventStore.claim(child.childId, "child", 60000))!;
      const childFence = { eventId: claim.event.id, ownerId: claim.ownerId, generation: claim.generation };
      // The child's queued execution, then its resource use, keep the
      // Sandbox in use as the parent lets go: no read may fall between them.
      const reads = await Promise.all([
        stores.delegationStore.startExecution(child.id, childFence, "child-turn", {}).then(() => true),
        stores.delegationStore.releaseResourceUse(parent.id, fence).then(() => true),
        ...Array.from({ length: 4 }, () => stores.delegationStore.hasResourceUsers(parent.id)),
      ]);
      expect(reads).toEqual(Array(6).fill(true));
      await stores.delegationStore.finishExecution(child.id, childFence, outcome(child));
      expect(await stores.delegationStore.hasResourceUsers(parent.id)).toBe(false);
    }));
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
  it("C7 rejects an expired owner at commit and hands its running execution to the claim that takes over", async () => {
    const child = await stores.delegationStore.accept(caller, parentFence); const oldFence = await start(child);
    await harness.pool.query("UPDATE pending_events SET claim_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [child.pendingEventId]);
    const claim = (await stores.pendingEventStore.claim(child.childId, "new-owner", 60000))!;
    const newFence = { eventId: claim.event.id, ownerId: claim.ownerId, generation: claim.generation };
    await expect(stores.delegationStore.finishExecution(child.id, oldFence, outcome(child))).rejects.toThrow();
    expect(await stores.delegationStore.startExecution(child.id, newFence, "child-turn", {}))
      .toMatchObject({ status: "running", turnId: "child-turn", ownerId: "new-owner", generation: newFence.generation });
    expect((await stores.pendingEventStore.listUnclaimed(caller.callerSessionId, 10)).filter((event) => event.type === "subagent.result")).toEqual([]);
    expect((await stores.delegationStore.finishExecution(child.id, newFence, outcome(child))).status).toBe("completed");
    expect((await stores.pendingEventStore.listUnclaimed(caller.callerSessionId, 10)).filter((event) => event.type === "subagent.result")).toHaveLength(1);
  });
  it("C10 counts a sibling with an expired owner against the limit, without ending it", async () => {
    const lost = await stores.delegationStore.accept({ ...caller, maxConcurrent: 1 }, parentFence); await start(lost);
    await harness.pool.query("UPDATE pending_events SET claim_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [lost.pendingEventId]);
    await expect(stores.delegationStore.accept({ ...caller, maxConcurrent: 1, callerToolUseId: "second" }, parentFence)).rejects.toThrow(DelegationLimitReached);
    expect((await stores.delegationStore.getExecution("tenant", lost.id))?.status).toBe("running");
    expect((await stores.eventLogStore.getEvents(caller.callerSessionId)).data).toEqual([]);
  });
});
