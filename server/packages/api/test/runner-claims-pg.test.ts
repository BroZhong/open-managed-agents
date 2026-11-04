import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPgStores, type Agent, type Pool, type PgStores, type Session } from "@oma-server/store";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { SessionRouter, type SessionRouterDeps } from "@oma-server/session-router";
import type { Adapter, SessionEvent } from "@open-managed-agents/adapter-core";
import { journalWriter } from "@open-managed-agents/adapter-mock";
import { createPgTestHarness, type PgTestHarness } from "../../store/test/pg-harness.js";

/**
 * Runners competing for a Session's head on one PostgreSQL (#325, ADR-0026):
 * a claim never waits for a head another transaction holds, a Runner whose
 * claim took nothing reads and retries nothing more, and what the holder of
 * the head leaves is found by the wake it sends or by the next pending scan.
 * Each Router has its own pool wrapper, which records every statement it
 * sends, BEGIN and COMMIT included.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean> | boolean, timeout = 5_000) {
  const start = Date.now();
  while (!await check()) { if (Date.now() - start > timeout) throw new Error("Timed out"); await sleep(10); }
}
const event = (type: string, data: object = {}) => ({ id: randomUUID(), timestamp: new Date().toISOString(), type, ...data }) as SessionEvent;

/** The pool as one Runner uses it, recording each statement's SQL. */
function countingPool(pool: Pool): { pool: Pool; statements: string[] } {
  const statements: string[] = [];
  const text = (query: unknown) => (typeof query === "string" ? query : (query as { text: string }).text).replace(/\s+/g, " ").trim();
  const counted = {
    query: (...args: unknown[]) => { statements.push(text(args[0])); return (pool.query as (...a: unknown[]) => unknown)(...args); },
    connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, key) {
          if (key === "query") return (...args: unknown[]) => { statements.push(text(args[0])); return (target.query as (...a: unknown[]) => unknown)(...args); };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  } as unknown as Pool;
  return { pool: counted, statements };
}

describe.skipIf(!process.env.PG_TEST_URL)("Runners competing for a Session's head on real PostgreSQL (#325)", () => {
  let harness: PgTestHarness;
  let stores: PgStores;
  let agent: Agent;
  let session: Session;
  beforeAll(async () => { harness = await createPgTestHarness(); });
  afterAll(async () => { await harness.close(); });
  beforeEach(async () => {
    await harness.reset();
    stores = await createPgStores(harness.pool, { ensureSchema: false });
    agent = await stores.agentStore.create({ tenantId: "tenant", name: "Test", model: "test", system: "test", runtime: "mock", sandbox: { enabled: false } });
    const workspace = await stores.workspaceStore.create({ tenantId: "tenant" });
    session = await stores.sessionStore.create({ tenantId: "tenant", agentId: agent.id, agent, workspaceId: workspace.id });
  });

  const enqueue = (text = "work") => stores.pendingEventStore.enqueue(session.id, {
    type: "user.message", data: { content: [{ type: "text", text }] }, sessionThreadId: "sthr_primary",
  });
  const idle = async () => (await stores.sessionStore.getById(session.id))?.status === "idle" &&
    await stores.pendingEventStore.count(session.id) === 0;
  const answering: Adapter = {
    async run(input) {
      await journalWriter(input)(event("agent.message", { content: [{ type: "text", text: "done" }] }));
      return "finished";
    },
  };
  /** A Runner over its own counting pool; `wake` reaches the Routers it names, as the Redis wake does. */
  async function runner(name: string, adapter: Adapter = answering, deps: Partial<SessionRouterDeps> = {}) {
    const { pool, statements } = countingPool(harness.pool);
    const errors: unknown[] = [];
    const router = new SessionRouter({
      ...await createPgStores(pool, { ensureSchema: false }), eventStreamHub: new InProcessEventStreamHub(),
      resolveAdapter: () => adapter, pendingClaimOwnerId: name,
      pendingClaimRetryMinMs: 10, pendingClaimRetryMaxMs: 20,
      onDrainError: ({ error }) => errors.push(error), ...deps,
    });
    return { router, statements, errors };
  }
  /** Another transaction holding the head's row lock, as a competing claim does until it commits. */
  async function lockHead() {
    const client = await harness.pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT id FROM pending_events WHERE session_id = $1 ORDER BY seq LIMIT 1 FOR UPDATE", [session.id]);
    return async () => { await client.query("ROLLBACK"); client.release(); };
  }

  it("a head another transaction holds is skipped at once by every woken Runner, one claim each and no retry; the next scan claims it once the holder rolled back", async () => {
    await enqueue();
    const rollback = await lockHead();
    const runners = await Promise.all(["runner-a", "runner-b", "runner-c"].map((name) => runner(name)));

    const started = Date.now();
    await Promise.all(runners.map(({ router }) => router.handleNewEvent(session.id, agent)));
    expect(Date.now() - started).toBeLessThan(1_000);
    // Long enough for several claim retries, if a Runner scheduled one.
    await sleep(200);
    for (const { statements, errors } of runners) {
      // One claim transaction: the head lock found the row held and took nothing.
      expect(statements).toHaveLength(3);
      expect(statements[0]).toBe("BEGIN");
      expect(statements[1]).toMatch(/FOR UPDATE SKIP LOCKED$/);
      expect(statements[2]).toBe("COMMIT");
      expect(errors).toEqual([]);
    }

    // The holder was a claim that rolled back: nobody owns the head now, and
    // the pending scan, not a retry, finds it.
    await rollback();
    await sleep(100);
    expect(runners.map(({ statements }) => statements.length)).toEqual([3, 3, 3]);
    await runners[1].router.recoverPendingEvents();
    await until(idle);
    const { rows } = await harness.pool.query("SELECT type FROM events WHERE session_id = $1 AND type = 'session.turn_completed'", [session.id]);
    expect(rows).toHaveLength(1);
  });

  it("Runners woken for the same head race for it: one claims it, and each other makes one claim attempt, waits for no lock and reads nothing more", async () => {
    await enqueue();
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const owners: string[] = [];
    const runners = await Promise.all(["runner-a", "runner-b", "runner-c", "runner-d"].map((name) => runner(name, {
      async run(input) {
        owners.push(name);
        await released;
        await journalWriter(input)(event("agent.message", { content: [{ type: "text", text: "done" }] }));
        return "finished";
      },
    })));
    const drains = runners.map(({ router }) => router.handleNewEvent(session.id, agent));
    await until(() => owners.length === 1);
    const winner = runners.find((_, index) => ["runner-a", "runner-b", "runner-c", "runner-d"][index] === owners[0])!;
    const losers = runners.filter((candidate) => candidate !== winner);
    // The losers' drains end while the winner's Turn still runs.
    await Promise.all(drains.filter((_, index) => runners[index] !== winner));
    await sleep(100);
    for (const { statements } of losers) {
      // BEGIN, the head lock, then COMMIT: a head the winner was claiming
      // was skipped; one it had claimed was locked, found under its live
      // claim and left. Neither is retried or read again.
      expect(statements[0]).toBe("BEGIN");
      expect(statements.at(-1)).toBe("COMMIT");
      expect(statements.length === 3 || statements.length === 4).toBe(true);
      expect(statements.filter((sql) => sql === "BEGIN")).toHaveLength(1);
    }
    release();
    await Promise.all(drains);
    await until(idle);
    expect(owners).toHaveLength(1);
  });

  it("a Runner that shuts down releases the head of the Turn it hands over, and the Runner its wake reaches claims it without a pending scan", async () => {
    await enqueue();
    const running: string[] = [];
    let b!: SessionRouter;
    const a = await runner("runner-a", {
      async run(input) {
        running.push("runner-a");
        // A Turn that runs until its Runner asks it to stop at its next request.
        await until(() => input.stopRequest?.aborted === true, 10_000);
        return "stopped";
      },
    }, { wakeSession: (sessionId) => void b.handleNewEvent(sessionId, agent) });
    const recovered: string[] = [];
    const bRunner = await runner("runner-b");
    b = bRunner.router;
    b.recoverPendingEvents = async () => { recovered.push("runner-b"); throw new Error("no pending scan in this test"); };

    void a.router.handleNewEvent(session.id, agent);
    await until(() => running.length === 1);
    expect(await a.router.handOff(5_000)).toBe(true);
    await until(idle);

    const { rows } = await harness.pool.query<{ type: string; data: { reason?: string } }>(
      "SELECT type, data FROM events WHERE session_id = $1 AND type IN ('session.turn_resumed', 'session.turn_completed') ORDER BY seq", [session.id]);
    expect(rows.map((row) => [row.type, row.data.reason])).toEqual([["session.turn_resumed", "released"], ["session.turn_completed", undefined]]);
    expect(recovered).toEqual([]);
    expect([...a.errors, ...bRunner.errors]).toEqual([]);
  });
});
