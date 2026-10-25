import { InMemoryEnvironmentStore } from "../src/index.js";
import { environmentStoreContract } from "../../store/test/environment-store-contract.js";

environmentStoreContract("InMemoryEnvironmentStore", async () => new InMemoryEnvironmentStore());

import { environmentBuildQueueContract } from "../../store/test/environment-build-queue-contract.js";

environmentBuildQueueContract("InMemoryEnvironmentStore build queue", async () => {
  let offset = 0;
  const store = new InMemoryEnvironmentStore({ now: () => new Date(Date.now() + offset) });
  return { store, expireLeases: async () => { offset += 24 * 60 * 60 * 1000; } };
});
