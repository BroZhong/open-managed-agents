import { describe, expect, it } from "vitest";
import { createPgStores, PgAdvisoryLeadership, PgDelegationStore, PgSandboxLifecycleStore, type Pool } from "@oma-server/store";
import { DefaultSandboxManager, FakeSandboxClient, SANDBOX_BINDING_LABEL, SANDBOX_ENVIRONMENT_LABEL, SandboxSweeper } from "@oma-server/sandbox";
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
    session: async (environmentId) => (await stores.sessionStore.create({ tenantId: "tenant_1", agentId: agent.id, agent, workspaceId: "ws_1",
      ...(environmentId ? { environmentId } : {}) })).id,
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
    origin: async (bindingId) => {
      const { rows: [row] } = await pool.query<{ environment_id: string | null; image: string | null }>(
        "SELECT environment_id, image FROM delegation_environments WHERE id = $1", [bindingId]);
      return row ? { environmentId: row.environment_id, image: row.image } : null;
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

/**
 * One Runner of an environment sweeps per period (ADR-0026, #326): the
 * Runners share the schema and the gateway, and each asks for the lead at
 * its own period. A period is driven here as each Runner's timer drives it.
 */
describe.skipIf(!process.env.PG_TEST_URL)("one Runner sweeps per period over PostgreSQL, the one holding the schema's advisory lock", () => {
  async function environment() {
    const harness = await createPgTestHarness();
    const gateway = new FakeSandboxClient();
    const runner = () => {
      const lifecycle = new PgSandboxLifecycleStore(harness.pool);
      const rounds: unknown[] = [];
      const sweeper = new SandboxSweeper({ client: gateway, facts: lifecycle, bindings: new PgDelegationStore(harness.pool),
        manager: new DefaultSandboxManager({ sandboxClient: gateway, environment: "test", lifecycle }), environment: "test",
        leadership: new PgAdvisoryLeadership({ connectionString: process.env.PG_TEST_URL, schema: harness.schema }, "sandbox_sweeper", "oma-runner"),
        logger: { info: (line: string) => { const parsed = JSON.parse(line); if (parsed.msg === "sandbox_sweep") rounds.push(parsed); } } });
      return { sweeper, rounds };
    };
    const orphan = async () => (await gateway.create({ image: "image", metadata: { [SANDBOX_BINDING_LABEL]: `sesn_gone_${gateway.created.length}`, [SANDBOX_ENVIRONMENT_LABEL]: "test" } })).id;
    return { harness, gateway, runner, orphan };
  }

  it("sweeps on the Runner that asked first, every period, and on another from its next period once that one stops", async () => {
    const env = await environment();
    try {
      const [a, b] = [env.runner(), env.runner()];
      const first = await env.orphan();
      expect(await a.sweeper.period()).toEqual(expect.objectContaining({ killed: 1 }));
      expect(await b.sweeper.period()).toBeNull();
      const second = await env.orphan();
      expect(await b.sweeper.period()).toBeNull();
      expect(await a.sweeper.period()).toEqual(expect.objectContaining({ killed: 1 }));
      expect(env.gateway.destroyed).toEqual([first, second]);
      await a.sweeper.stop();
      const third = await env.orphan();
      expect(await b.sweeper.period()).toEqual(expect.objectContaining({ killed: 1 }));
      expect(env.gateway.destroyed).toEqual([first, second, third]);
      expect([a.rounds.length, b.rounds.length]).toEqual([2, 1]);
      await b.sweeper.stop();
    } finally { await env.harness.close(); }
  });

  it("elects a Runner in each environment: another schema's leader excludes none of this one's", async () => {
    const [production, test] = [await environment(), await environment()];
    try {
      const [here, there] = [production.runner(), test.runner()];
      expect(await here.sweeper.period()).not.toBeNull();
      expect(await there.sweeper.period()).not.toBeNull();
      await Promise.all([here.sweeper.stop(), there.sweeper.stop()]);
    } finally { await Promise.all([production.harness.close(), test.harness.close()]); }
  });
});
