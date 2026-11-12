import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgPool, PgSessionCleanupStore, type Pool } from "../src/index.js";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";

// #337: cleanup's Sandbox callback may itself need a database connection.
// pg-mem cannot reproduce pooled-client exhaustion or PostgreSQL row locks.
describe.skipIf(!process.env.PG_TEST_URL)("Session cleanup on a two-connection PostgreSQL pool", () => {
  let harness: PgTestHarness;
  let pool: Pool;
  beforeAll(async () => {
    harness = await createPgTestHarness();
    pool = createPgPool({ connectionString: process.env.PG_TEST_URL, schema: harness.schema,
      max: 2, connectionTimeoutMillis: 1_000 });
  });
  afterAll(async () => { await pool?.end(); await harness?.close(); });

  it("releases transactions and clients before concurrent cleanup callbacks borrow the same pool", async () => {
    const ids = Array.from({ length: 6 }, (_, n) => `cleanup-pool-${n}`);
    await pool.query("INSERT INTO session_cleanup (session_id) SELECT unnest($1::text[])", [ids]);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Set<string>();
    const completed: string[] = [];
    let peak = 0;
    const sweeps = Array.from({ length: 4 }, () => new PgSessionCleanupStore(pool).sweep(async id => {
      entered.add(id);
      peak = Math.max(peak, entered.size);
      await gate; // A slow external Sandbox request, while other Runners sweep.
      await pool.query("SELECT 1"); // The callback's nested store access.
      completed.push(id);
      entered.delete(id);
      return true;
    }));
    // Register rejection handlers before checking the stalled callbacks.
    const settled = Promise.allSettled(sweeps);
    try {
      await expect.poll(() => entered.size, { timeout: 3_000 }).toBeGreaterThan(2);
      expect((pool as Pool & { waitingCount: number }).waitingCount).toBe(0);
      const tx = await harness.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND state = 'idle in transaction' AND query LIKE '%session_cleanup%'",
      );
      expect(tx.rows[0].n).toBe(0);
      // Another connection can lock every claimed row while callbacks wait.
      const client = await harness.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout = '500ms'");
        const rows = await client.query("SELECT session_id FROM session_cleanup FOR UPDATE NOWAIT");
        expect(rows.rows).toHaveLength(ids.length);
      } finally { await client.query("ROLLBACK"); client.release(); }
    } finally { release(); await settled; }
    expect((await settled).every(result => result.status === "fulfilled")).toBe(true);
    expect(peak).toBeGreaterThan(2);
    expect(completed.sort()).toEqual(ids);
    const rows = await pool.query<{ attempts: number; completed: boolean }>(
      "SELECT attempts, completed_at IS NOT NULL AS completed FROM session_cleanup",
    );
    expect(rows.rows).toHaveLength(ids.length);
    expect(rows.rows.every(row => row.attempts === 1 && row.completed)).toBe(true);
    await new PgSessionCleanupStore(pool).sweep(async () => { throw new Error("completed cleanup repeated"); });
    expect(completed).toHaveLength(ids.length);
  });
});
