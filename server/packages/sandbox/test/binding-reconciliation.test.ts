import { createMemoryStores } from "@oma-server/store-memory";
import { bindingReconciliationContract } from "./binding-reconciliation-contract.js";
import { databaseClock } from "./bindings.js";

bindingReconciliationContract("Sandbox binding reconciliation over the in-memory stores", async () => {
  const clock = databaseClock(new Date("2026-10-22T13:19:30Z"));
  const stores = createMemoryStores({ databaseClock: clock.now });
  return {
    ...stores,
    elapse: async (seconds) => clock.elapse(seconds),
    // Migration 0024 writes the epoch: commit the intent while the clock reads it.
    legacyPending: async (bindingId) => {
      const now = clock.now();
      clock.set(new Date(0));
      try { await stores.delegationStore.withEnvironmentLock(bindingId, async () => ({ next: "creating", value: undefined })); }
      finally { clock.set(now); }
    },
  };
}, { clockMoves: true });
