import { createPgStores, PgDelegationStore, PgSandboxLifecycleStore, type Pool } from "@oma-server/store";
import { createPgTestHarness, type PgTestHarness } from "../../store/test/pg-harness.js";
import { sandboxSweeperContract, type SweeperStores } from "../../sandbox/test/sandbox-sweeper-contract.js";

/**
 * The sweeper (#291) over the PostgreSQL stores: each Runner its own
 * delegation store (whose binding operations queue only behind its own) and
 * the lifecycle store's reads of the bindings, Turn admission and
 * reclamation, over one pool. The contract lives with the sandbox package; it
 * runs here, where the PostgreSQL test harness is reachable. now() is real
 * time, so time passes for an intent by moving it back.
 */
async function storesOver(pool: Pool): Promise<SweeperStores> {
  const stores = await createPgStores(pool, { ensureSchema: false });
  const agent = await stores.agentStore.create({ tenantId: "tenant_1", name: "agent", model: "model", runtime: "pi-agent", system: "" });
  return {
    runner: () => {
      const lifecycle = new PgSandboxLifecycleStore(pool);
      return { bindings: new PgDelegationStore(pool), facts: lifecycle, lifecycle };
    },
    session: async () => (await stores.sessionStore.create({ tenantId: "tenant_1", agentId: agent.id, agent, workspaceId: "ws_1" })).id,
    queue: async (sessionId) => { await stores.pendingEventStore.enqueue(sessionId, { type: "user.message", data: {}, sessionThreadId: "sthr_primary" }); },
    admit: async (sessionId) => {
      await stores.pendingEventStore.enqueue(sessionId, { type: "user.message", data: {}, sessionThreadId: "sthr_primary" });
      const claim = (await stores.pendingEventStore.claim(sessionId, "runner", 60_000))!;
      return { sessionId, bindingId: sessionId, fence: { eventId: claim.event.id, ownerId: claim.ownerId, generation: claim.generation } };
    },
    terminate: async (sessionId) => {
      await stores.sessionStore.terminate(sessionId);
      await stores.pendingEventStore.clear(sessionId);
    },
    // As claimReclamation leaves it: terminated, claimed, not completed.
    reclaiming: async (bindingId) => {
      await stores.sessionStore.terminate(bindingId);
      await pool.query("UPDATE delegation_environments SET reclaiming = TRUE WHERE id = $1", [bindingId]);
    },
    elapse: async (seconds) => {
      await pool.query(`UPDATE delegation_environments SET creating_since = creating_since - interval '${Number(seconds)} seconds' WHERE creating_since IS NOT NULL`);
    },
    row: async (bindingId) => {
      const { rows: [row] } = await pool.query<{ sandbox_id: string | null; creating_since: Date | null }>(
        "SELECT sandbox_id, creating_since FROM delegation_environments WHERE id = $1", [bindingId]);
      return row ? { sandboxId: row.sandbox_id, creatingSince: row.creating_since } : null;
    },
  };
}

let harness: PgTestHarness | undefined;
sandboxSweeperContract("the Sandbox sweeper over PostgreSQL", async () => {
  if (!harness) harness = await createPgTestHarness(); else await harness.reset();
  return storesOver(harness.pool);
  // On pg-mem, without row locks, two Runners' concurrent rounds are not
  // PostgreSQL's, and Turn admission and reclamation do not parse.
}, { teardown: async () => { await harness?.close(); }, rowLocks: Boolean(process.env.PG_TEST_URL), reclamation: Boolean(process.env.PG_TEST_URL) });
