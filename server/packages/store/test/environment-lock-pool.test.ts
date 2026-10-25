import { describe, beforeAll, afterAll, it, expect } from "vitest";
import { createPgPool, createPgStores, type Pool, type PgStores } from "../src/index.js";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";

// Real PostgreSQL is required: the regression is pooled-client exhaustion.
describe.skipIf(!process.env.PG_TEST_URL)("Sandbox environment lock on a bounded PostgreSQL pool", () => {
  let harness: PgTestHarness;
  let pool: Pool;
  let stores: PgStores;
  beforeAll(async () => {
    harness = await createPgTestHarness();
    // The Runner incident: every pooled client held a binding transaction while
    // its Sandbox callback (canExecute → sessions.getById) waited for one more.
    pool = createPgPool({ connectionString: process.env.PG_TEST_URL, schema: harness.schema, max: 2, connectionTimeoutMillis: 5_000 });
    stores = await createPgStores(pool, { ensureSchema: false });
  });
  afterAll(async () => { await pool?.end(); await harness?.close(); });

  it("never holds a pooled client while Sandbox work queries the same pool", async () => {
    const bindings = Array.from({ length: 6 }, (_, index) => `binding-${index}`);
    let inside = 0;
    let peak = 0;
    const results = await Promise.all(bindings.map(binding => stores.delegationStore.withEnvironmentLock(binding, async () => {
      peak = Math.max(peak, ++inside);
      await new Promise(resolve => setTimeout(resolve, 50));
      await pool.query("SELECT 1");
      inside--;
      return { next: { ready: `sandbox-${binding}` }, value: binding };
    })));
    expect(results).toEqual(bindings);
    // Unrelated bindings proceed concurrently beyond the pool size.
    expect(peak).toBeGreaterThan(2);
    const rows = await pool.query<{ id: string; sandbox_id: string }>("SELECT id, sandbox_id FROM delegation_environments WHERE id = ANY($1) ORDER BY id", [bindings]);
    expect(rows.rows.map(row => row.sandbox_id)).toEqual(bindings.map(binding => `sandbox-${binding}`));
    const idle = await pool.query<{ count: string }>("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'");
    expect(Number(idle.rows[0].count)).toBe(0);
  });

  it("serializes one binding in process and rejects a concurrent durable writer", async () => {
    const order: string[] = [];
    await Promise.all([1, 2].map(n => stores.delegationStore.withEnvironmentLock("serial", async ({ sandboxId }) => {
      order.push(`start-${n}:${sandboxId}`);
      await new Promise(resolve => setTimeout(resolve, 20));
      order.push(`end-${n}`);
      return { next: { ready: `sandbox-${n}` }, value: undefined };
    })));
    expect(order).toEqual(["start-1:null", "end-1", "start-2:sandbox-1", "end-2"]);

    const other = await createPgStores(pool, { ensureSchema: false });
    await expect(stores.delegationStore.withEnvironmentLock("serial", async ({ sandboxId }) => {
      // Another Runner commits a different binding while this callback runs.
      await other.delegationStore.withEnvironmentLock("serial", async () => ({ next: { ready: "foreign" }, value: undefined }));
      return { next: { ready: `${sandboxId}-replaced` }, value: undefined };
    })).rejects.toThrow("changed concurrently");
    expect(await stores.delegationStore.withEnvironmentLock("serial", async ({ sandboxId }) => ({ value: sandboxId }))).toBe("foreign");
    // An intent another Runner committed meanwhile also fails a move.
    await expect(stores.delegationStore.withEnvironmentLock("serial", async () => {
      await other.delegationStore.withEnvironmentLock("serial", async () => ({ next: "creating", value: undefined }));
      return { next: "cold", value: undefined };
    })).rejects.toThrow("changed concurrently");
    expect(await stores.delegationStore.withEnvironmentLock("serial", async ({ creatingSince }) => ({ value: creatingSince }))).toBeInstanceOf(Date);
  });
});
