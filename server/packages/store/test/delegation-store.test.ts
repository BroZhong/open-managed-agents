import { createPgStores } from "../src/index.js";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";
import { delegationContract } from "./delegation-contract.js";
let harness: PgTestHarness | undefined;
delegationContract("PostgreSQL delegation lifecycle", async () => {
  if (!harness) harness = await createPgTestHarness();
  else await harness.reset();
  return createPgStores(harness.pool, { ensureSchema: false });
}, async () => { await harness?.close(); });
