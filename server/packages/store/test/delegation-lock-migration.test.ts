import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPgStores, type PgStores } from "../src/index.js";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";

const migration = (name: string) => readFile(new URL(`../../../../deploy/migrations/${name}`, import.meta.url), "utf8");

// Real PostgreSQL only: pg-mem runs neither DO blocks nor DROP TABLE faithfully.
describe.skipIf(!process.env.PG_TEST_URL)("migration 0031: the Delegation Family lock replaces delegation_lock (ADR-0027)", () => {
  let harness: PgTestHarness;
  let stores: PgStores;
  /** A migration as the environment runner would apply it, to the harness's schema. */
  const apply = async (name: string) => harness.pool.query((await migration(name)).replaceAll("oma.", `${harness.schema}.`));
  const lockRows = async () => {
    const table = await harness.pool.query("SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'delegation_lock'", [harness.schema]);
    return table.rows.length ? (await harness.pool.query<{ id: string }>("SELECT id FROM delegation_lock")).rows.map(({ id }) => id) : null;
  };
  /** One delegation, accepted and published, as a Runner of the family-lock image makes it. */
  const delegate = async (toolUseId: string) => {
    const agent = await stores.agentStore.create({ tenantId: "tenant", name: "agent", system: "", model: "model", runtime: "pi" });
    const parent = await stores.sessionStore.create({ tenantId: "tenant", agentId: agent.id, agent, workspaceId: "workspace" });
    await stores.pendingEventStore.enqueue(parent.id, { type: "user.message", data: {}, sessionThreadId: "sthr_primary" });
    const claim = (await stores.pendingEventStore.claim(parent.id, "parent", 60000))!;
    const fence = { eventId: claim.event.id, ownerId: claim.ownerId, generation: claim.generation };
    const child = await stores.delegationStore.accept({ tenantId: "tenant", callerSessionId: parent.id, callerTurnId: "turn", callerToolUseId: toolUseId,
      mode: "async", prompt: "task", parentModel: "provider/model", maxSteps: 30, maxConcurrent: 4, sandboxSessionId: parent.id }, fence);
    const childClaim = (await stores.pendingEventStore.claim(child.childId, "child", 60000))!;
    const childFence = { eventId: childClaim.event.id, ownerId: childClaim.ownerId, generation: childClaim.generation };
    await stores.delegationStore.startExecution(child.id, childFence, "child-turn", {});
    return stores.delegationStore.finishExecution(child.id, childFence, { status: "completed", reason: "done", output: "", trace: { sessionId: child.childId } });
  };

  beforeEach(async () => {
    if (!harness) harness = await createPgTestHarness(); else await harness.reset();
    stores = await createPgStores(harness.pool, { ensureSchema: false });
  });
  afterAll(async () => { await harness?.close(); });

  it("drops the row, and delegation runs without it; the rollback restores it for the previous image; both run twice", async () => {
    // The schema as 0012 left production: the global coordination row.
    await apply("0031_drop_delegation_lock.rollback.sql");
    expect(await lockRows()).toEqual(["coordination"]);
    expect((await delegate("before")).status).toBe("completed");

    await apply("0031_drop_delegation_lock.sql");
    await apply("0031_drop_delegation_lock.sql");
    expect(await lockRows()).toBeNull();
    expect((await delegate("after")).status).toBe("completed");

    await apply("0031_drop_delegation_lock.rollback.sql");
    await apply("0031_drop_delegation_lock.rollback.sql");
    expect(await lockRows()).toEqual(["coordination"]);
    // The previous image's lock statement finds its row again.
    await expect(harness.pool.query("SELECT id FROM delegation_lock WHERE id = 'coordination' FOR UPDATE")).resolves.toMatchObject({ rowCount: 1 });
  });

  it("creates no delegation_lock in a new schema", async () => {
    expect(await lockRows()).toBeNull();
  });
});
