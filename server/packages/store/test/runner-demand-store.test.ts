import { describe, beforeEach, afterAll, it, expect } from "vitest";
import { createPgStores, PgRunnerDemandStore, type DelegationOrigin, type PgStores } from "../src/index.js";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";

/**
 * The Runner demand KEDA scales the Runners on (ADR-0026), read from the
 * pending input queue: each Session counts once, by its head input. Real
 * PostgreSQL only: the read sets a transaction-local statement timeout.
 */
describe.skipIf(!process.env.PG_TEST_URL)("PgRunnerDemandStore on real PostgreSQL", () => {
  let harness: PgTestHarness;
  let stores: PgStores;
  let demand: PgRunnerDemandStore;
  beforeEach(async () => {
    if (!harness) harness = await createPgTestHarness(); else await harness.reset();
    stores = await createPgStores(harness.pool, { ensureSchema: false });
    demand = new PgRunnerDemandStore(harness.pool);
  });
  afterAll(async () => { await harness?.close(); });

  async function session(over: PgStores = stores, delegation?: DelegationOrigin) {
    const agent = await over.agentStore.create({ tenantId: "tenant", name: "agent", system: "", model: "model", runtime: "pi-agent" });
    return (await over.sessionStore.create({ tenantId: "tenant", agentId: agent.id, agent, workspaceId: "workspace", ...(delegation ? { delegation } : {}) })).id;
  }
  async function queue(sessionId: string, inputs = 1, over: PgStores = stores) {
    for (let i = 0; i < inputs; i++) await over.pendingEventStore.enqueue(sessionId, { type: "user.message", data: {}, sessionThreadId: "sthr_primary" });
  }
  async function claim(sessionId: string, over: PgStores = stores) {
    return (await over.pendingEventStore.claim(sessionId, "runner", 60_000))!;
  }
  /** A delegation wait of the head input, as `saveWait` stores it. */
  async function wait(sessionId: string, parentPendingEventId: string, status: "waiting" | "consumed" | "cancelled" = "waiting") {
    const record = { tenantId: "tenant", callerSessionId: sessionId, callerTurnId: "turn", callerToolUseId: `tool_${status}`,
      executionId: "execution", parentPendingEventId, config: {}, status };
    await harness.pool.query("INSERT INTO delegation_waits (id, record) VALUES ($1, $2)",
      [JSON.stringify(["tenant", sessionId, "turn", record.callerToolUseId]), JSON.stringify(record)]);
  }
  const counts = async (reader = demand) => {
    const { observedAt: _observedAt, ...rest } = await reader.read(5_000);
    return rest;
  };

  it("reads no demand from an empty queue, observed by the database clock", async () => {
    const before = Date.now();
    const read = await demand.read(5_000);
    expect(read).toEqual({ demand: 0, executing: 0, syncWaiting: 0, ready: 0, observedAt: expect.any(Date) });
    expect(Math.abs(read.observedAt.getTime() - before)).toBeLessThan(60_000);
  });

  it("counts a Session with several queued inputs once, as ready", async () => {
    await queue(await session(), 3);
    expect(await counts()).toEqual({ demand: 1, executing: 0, syncWaiting: 0, ready: 1 });
  });

  it("counts a claimed head as executing, whatever is queued behind it", async () => {
    const id = await session();
    await queue(id, 3);
    await claim(id);
    expect(await counts()).toEqual({ demand: 1, executing: 1, syncWaiting: 0, ready: 0 });
  });

  it("counts an executing Child Session in executing", async () => {
    const parent = await session();
    const child = await session(stores, { parentSessionId: parent, parentTurnId: "turn", parentToolUseId: "tool", sandboxSessionId: parent });
    await queue(child);
    await claim(child);
    expect(await counts()).toEqual({ demand: 1, executing: 1, syncWaiting: 0, ready: 0 });
  });

  it("counts a Turn in a synchronous wait in syncWaiting, not in executing nor demand", async () => {
    const id = await session();
    await queue(id, 2);
    const head = await claim(id);
    await wait(id, head.event.id);
    expect(await counts()).toEqual({ demand: 0, executing: 0, syncWaiting: 1, ready: 0 });
  });

  it("counts a Turn executing again once its waits are consumed or cancelled", async () => {
    const id = await session();
    await queue(id);
    const head = await claim(id);
    await wait(id, head.event.id, "consumed");
    await wait(id, head.event.id, "cancelled");
    expect(await counts()).toEqual({ demand: 1, executing: 1, syncWaiting: 0, ready: 0 });
  });

  it("does not take a wait of another input of the Session for the head's", async () => {
    const id = await session();
    await queue(id);
    await claim(id);
    await wait(id, "another_input");
    expect(await counts()).toEqual({ demand: 1, executing: 1, syncWaiting: 0, ready: 0 });
  });

  it("counts a head whose lease expired or was released as ready", async () => {
    const [expired, released] = [await session(), await session()];
    await queue(expired);
    await queue(released);
    await claim(expired);
    const held = await claim(released);
    await harness.pool.query("UPDATE pending_events SET claim_expires_at = clock_timestamp() - interval '1 second' WHERE session_id = $1", [expired]);
    await stores.pendingEventStore.releaseClaim(released, held.event.id, held);
    expect(await counts()).toEqual({ demand: 2, executing: 0, syncWaiting: 0, ready: 2 });
  });

  it("does not count a terminated Session's unclaimed input as ready", async () => {
    const id = await session();
    await queue(id);
    await stores.sessionStore.terminate(id);
    expect(await counts()).toEqual({ demand: 0, executing: 0, syncWaiting: 0, ready: 0 });
  });

  it("adds executing and ready into demand", async () => {
    const [running, waiting, queued] = [await session(), await session(), await session()];
    for (const id of [running, waiting, queued]) await queue(id, 2);
    await claim(running);
    await wait(waiting, (await claim(waiting)).event.id);
    expect(await counts()).toEqual({ demand: 2, executing: 1, syncWaiting: 1, ready: 1 });
  });

  it("counts only its own schema: test and production share the database", async () => {
    const other = await createPgTestHarness();
    try {
      const otherStores = await createPgStores(other.pool, { ensureSchema: false });
      const otherSession = await session(otherStores);
      await queue(otherSession, 1, otherStores);
      await claim(otherSession, otherStores);
      await queue(await session());
      expect(await counts()).toEqual({ demand: 1, executing: 0, syncWaiting: 0, ready: 1 });
      expect(await counts(new PgRunnerDemandStore(other.pool))).toEqual({ demand: 1, executing: 1, syncWaiting: 0, ready: 0 });
    } finally { await other.close(); }
  });

  it("fails within its timeout instead of waiting for a stalled query", async () => {
    await queue(await session());
    const locker = await harness.pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("LOCK TABLE pending_events IN ACCESS EXCLUSIVE MODE");
      const started = Date.now();
      await expect(demand.read(300)).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
    // The connection the stalled read used is usable again: its transaction ended.
    expect(await counts()).toEqual({ demand: 1, executing: 0, syncWaiting: 0, ready: 1 });
  });

  it("refuses a timeout that is not a positive integer of milliseconds", async () => {
    for (const timeoutMs of [0, -1, 1.5, Number.NaN]) await expect(demand.read(timeoutMs)).rejects.toThrow(RangeError);
  });
});
