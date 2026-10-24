import { readFile } from "node:fs/promises";
import { createPgStores, PgSandboxLifecycleStore, type Pool } from "@oma-server/store";
import { createPgTestHarness, type PgTestHarness } from "../../store/test/pg-harness.js";
import { bindingReconciliationContract, type ReconciliationStores } from "../../sandbox/test/binding-reconciliation-contract.js";

/**
 * Crash injection into Sandbox creation over the PostgreSQL stores (#284):
 * intents written and judged with PostgreSQL's clock, moves applied by the
 * store's compare-and-set. The contract lives with the sandbox package; it
 * runs here, where the PostgreSQL test harness is reachable. now() is real
 * time, so time passes for an intent by moving it back.
 */
async function storesOver(pool: Pool): Promise<ReconciliationStores> {
  return {
    ...await createPgStores(pool, { ensureSchema: false }),
    elapse: async (seconds) => {
      await pool.query(`UPDATE delegation_environments SET creating_since = creating_since - interval '${Number(seconds)} seconds' WHERE creating_since IS NOT NULL`);
    },
    legacyPending: async (bindingId) => {
      await pool.query(`INSERT INTO delegation_environments (id, sandbox_id, creating_since) VALUES ($1, NULL, $2)
        ON CONFLICT (id) DO UPDATE SET sandbox_id = NULL, creating_since = $2`, [bindingId, new Date(0)]);
    },
  };
}

let harness: PgTestHarness | undefined;
bindingReconciliationContract("Sandbox binding reconciliation over PostgreSQL", async () => {
  if (!harness) harness = await createPgTestHarness(); else await harness.reset();
  return storesOver(harness.pool);
}, { teardown: async () => { await harness?.close(); } });

// Real PostgreSQL only: the native lifecycle's row locks and queue trigger are
// its contract, and a claimed reclamation refuses every binding write (#288).
let native: PgTestHarness | undefined;
if (process.env.PG_TEST_URL) {
  bindingReconciliationContract("Sandbox binding reconciliation over PostgreSQL with the native lifecycle", async () => {
    if (!native) native = await createPgTestHarness(); else await native.reset();
    const migration = await readFile(new URL("../../../../deploy/migrations/0020_native_sandbox_lifecycle.sql", import.meta.url), "utf8");
    await native.pool.query(migration.replaceAll("oma.", `${native.schema}.`));
    const lifecycle = new PgSandboxLifecycleStore(native.pool);
    await lifecycle.assertReady();
    return { ...await storesOver(native.pool), lifecycle };
  }, { teardown: async () => { await native?.close(); } });
}
