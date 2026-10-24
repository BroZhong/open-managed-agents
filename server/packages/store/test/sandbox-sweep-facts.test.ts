import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPgStores, PgSandboxLifecycleStore, type PgStores, type Session } from "../src/index.js";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";

/**
 * The sweeper's one read of bindings and their Sessions (ADR-0023, #291),
 * on pg-mem and, with PG_TEST_URL, on real PostgreSQL. Busy must be what
 * claimReclamation calls busy, or the sweeper would shorten or kill a
 * Sandbox termination keeps.
 */
describe("the sweeper's binding facts on PostgreSQL", () => {
  let harness: PgTestHarness;
  let stores: PgStores;
  let facts: PgSandboxLifecycleStore;
  beforeEach(async () => {
    if (!harness) harness = await createPgTestHarness(); else await harness.reset();
    stores = await createPgStores(harness.pool, { ensureSchema: false });
    facts = new PgSandboxLifecycleStore(harness.pool);
  });
  afterAll(async () => { await harness?.close(); });

  const root = async () => {
    const agent = await stores.agentStore.create({ tenantId: "tenant", name: "agent", model: "model", runtime: "pi", system: "" });
    return stores.sessionStore.create({ tenantId: "tenant", agentId: agent.id, agent, workspaceId: "ws" });
  };
  const child = (parent: Session) => stores.sessionStore.create({ tenantId: parent.tenantId, agentId: parent.agentId, agent: parent.agent,
    workspaceId: parent.workspaceId, delegation: { parentSessionId: parent.id, parentTurnId: "turn", parentToolUseId: "tool", sandboxSessionId: parent.id } });
  const queue = (session: Session) => stores.pendingEventStore.enqueue(session.id, { type: "user.message", data: {}, sessionThreadId: "sthr_primary" });
  /** A Turn's resource use whose input was acknowledged since: only the use protects the binding. */
  const use = async (session: Session, bindingId: string) => {
    await queue(session);
    const claim = (await stores.pendingEventStore.claim(session.id, "runner", 60_000))!;
    const fence = { eventId: claim.event.id, ownerId: claim.ownerId, generation: claim.generation };
    await stores.delegationStore.acquireResourceUse(session.id, bindingId, fence);
    await stores.pendingEventStore.ack(session.id, fence.eventId, fence);
  };
  const bind = (bindingId: string, next: "cold" | "creating" | { ready: string }) =>
    stores.delegationStore.withEnvironmentLock(bindingId, async () => ({ next, value: undefined }));
  const rows = async () => Number((await harness.pool.query<{ n: string }>("SELECT count(*) AS n FROM delegation_environments")).rows[0].n);
  const unused = { reclaiming: false, inUse: false, allSessionsTerminated: false };

  it("reads each binding's row and whether a live Session has input pending for it", async () => {
    const idle = await root();
    const queuedForChild = await root();
    const used = await root();
    const terminated = await root();
    const parentGone = await root();
    await bind(idle.id, { ready: "sbx-idle" });
    await bind(queuedForChild.id, { ready: "sbx-child" });
    await queue(await child(queuedForChild));
    await bind(used.id, "creating");
    await use(used, used.id);
    // A use left after its input was acknowledged (an uncertain execution) is idle here.
    const leftover = await root();
    await bind(leftover.id, { ready: "sbx-leftover" });
    await use(leftover, leftover.id);
    await queue(used);
    await bind(terminated.id, { ready: "sbx-terminated" });
    // A terminated Session's leftover use and input protect nothing.
    await use(terminated, terminated.id);
    await queue(terminated);
    await stores.sessionStore.terminate(terminated.id);
    await bind(parentGone.id, "cold");
    await child(parentGone);
    await stores.sessionStore.terminate(parentGone.id);
    const { rows: [intent] } = await harness.pool.query<{ creating_since: Date }>("SELECT creating_since FROM delegation_environments WHERE id = $1", [used.id]);

    const read = await facts.sweepFacts([idle.id, queuedForChild.id, used.id, leftover.id, terminated.id, parentGone.id]);
    expect(Object.fromEntries(read.bindings)).toEqual({
      [idle.id]: { ...unused, sandboxId: "sbx-idle", creatingSince: null },
      [queuedForChild.id]: { ...unused, sandboxId: "sbx-child", creatingSince: null, inUse: true },
      [used.id]: { ...unused, sandboxId: null, creatingSince: intent.creating_since, inUse: true },
      [leftover.id]: { ...unused, sandboxId: "sbx-leftover", creatingSince: null },
      [terminated.id]: { ...unused, sandboxId: "sbx-terminated", creatingSince: null, allSessionsTerminated: true },
      // The Child still lives, so the binding is not all terminated; it queued nothing.
      [parentGone.id]: { ...unused, sandboxId: null, creatingSince: null },
    });
    // Termination stays conservative: it keeps a binding the sweeper may shorten.
    expect(await facts.claimReclamation(queuedForChild.id)).toBeNull();
    expect(await facts.claimReclamation(used.id)).toBeNull();
    expect(await facts.claimReclamation(leftover.id)).toBeNull();
  });

  it("reads a reclaiming binding and a binding without Sessions, leaves out one without a row and creates none", async () => {
    await bind("orphaned", { ready: "sbx-orphaned" });
    await bind("reclaimed", { ready: "sbx-reclaimed" });
    await harness.pool.query("UPDATE delegation_environments SET reclaiming = TRUE WHERE id = 'reclaimed'");
    const before = await rows();
    const read = await facts.sweepFacts(["orphaned", "reclaimed", "no-row", "orphaned"]);
    expect(Object.fromEntries(read.bindings)).toEqual({
      orphaned: { ...unused, sandboxId: "sbx-orphaned", creatingSince: null, allSessionsTerminated: true },
      reclaimed: { ...unused, sandboxId: "sbx-reclaimed", creatingSince: null, reclaiming: true, allSessionsTerminated: true },
    });
    expect(await rows()).toBe(before);
  });

  it("reads the database clock, also when no binding has a row", async () => {
    for (const ids of [[], ["no-row"]]) {
      const { rows: [{ now: before }] } = await harness.pool.query<{ now: Date }>("SELECT now() AS now");
      const read = await facts.sweepFacts(ids);
      expect(read.bindings.size).toBe(0);
      expect(read.now).toBeInstanceOf(Date);
      expect(read.now.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(read.now.getTime() - Date.now()).toBeLessThan(60_000);
    }
  });
});
