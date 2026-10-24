import { readFile } from "node:fs/promises";
import { createPgStores, PgSandboxLifecycleStore } from "@oma-server/store";
import { createPgTestHarness, type PgTestHarness } from "../../store/test/pg-harness.js";
import { turnSandboxesContract } from "../../sandbox/test/turn-sandboxes-contract.js";

/**
 * The Turn side of the Sandbox protocol over the PostgreSQL stores (#281).
 * The contract lives with the sandbox package; it runs here, where the
 * PostgreSQL test harness is reachable.
 */
let harness: PgTestHarness | undefined;
async function fresh(): Promise<PgTestHarness> {
  if (!harness) harness = await createPgTestHarness();
  else await harness.reset();
  return harness;
}
turnSandboxesContract("Turn Sandboxes over PostgreSQL", async () => createPgStores((await fresh()).pool, { ensureSchema: false }),
  { teardown: async () => { await harness?.close(); } });

// Real PostgreSQL only: the native lifecycle's row locks and queue trigger are its contract.
let native: PgTestHarness | undefined;
if (process.env.PG_TEST_URL) {
  turnSandboxesContract("Turn Sandboxes over PostgreSQL with the native lifecycle", async () => {
    if (!native) native = await createPgTestHarness(); else await native.reset();
    const migration = await readFile(new URL("../../../../deploy/migrations/0020_native_sandbox_lifecycle.sql", import.meta.url), "utf8");
    await native.pool.query(migration.replaceAll("oma.", `${native.schema}.`));
    const lifecycle = new PgSandboxLifecycleStore(native.pool);
    await lifecycle.assertReady();
    return { ...await createPgStores(native.pool, { ensureSchema: false }), lifecycle };
  }, { lifecycle: true, teardown: async () => { await native?.close(); } });
}
