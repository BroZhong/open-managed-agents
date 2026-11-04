import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PgPendingEventStore } from "../src/postgres/pending-event-store.js";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";

/**
 * A claim never waits for a Session's head another transaction has locked
 * (#325, ADR-0026): it takes nothing, and never the input queued behind it,
 * because the transaction holding the head handles it. Row locks are
 * PostgreSQL's; pg-mem takes none.
 */
describe.skipIf(!process.env.PG_TEST_URL)("a claim of a locked head on real PostgreSQL", () => {
  let harness: PgTestHarness;
  let store: PgPendingEventStore;
  beforeAll(async () => { harness = await createPgTestHarness(); });
  afterAll(async () => { await harness.close(); });
  beforeEach(async () => {
    await harness.reset();
    store = new PgPendingEventStore(harness.pool);
  });

  /** Another transaction holding the head's row lock, as a competing claim does until it commits. */
  async function lockHead(sessionId: string) {
    const client = await harness.pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT id FROM pending_events WHERE session_id = $1 ORDER BY seq LIMIT 1 FOR UPDATE", [sessionId]);
    return {
      commit: async () => { await client.query("COMMIT"); client.release(); },
      rollback: async () => { await client.query("ROLLBACK"); client.release(); },
    };
  }

  it("returns at once without a claim, and never claims the input queued behind the head", async () => {
    const head = await store.enqueue("sess_1", { type: "user.message", data: { n: 1 }, sessionThreadId: "t" });
    const behind = await store.enqueue("sess_1", { type: "user.message", data: { n: 2 }, sessionThreadId: "t" });
    const lock = await lockHead("sess_1");
    try {
      const started = Date.now();
      expect(await store.claim("sess_1", "runner-b", 60_000)).toBeNull();
      expect(Date.now() - started).toBeLessThan(1_000);
      const { rows } = await harness.pool.query<{ id: string; claim_owner: string | null; claim_generation: string }>(
        "SELECT id, claim_owner, claim_generation FROM pending_events ORDER BY seq");
      expect(rows.map((row) => [row.id, row.claim_owner, Number(row.claim_generation)]))
        .toEqual([[head.id, null, 0], [behind.id, null, 0]]);
    } finally {
      await lock.rollback();
    }
    // Once the lock is gone, the head is the one claimed.
    expect((await store.claim("sess_1", "runner-b", 60_000))?.event.id).toBe(head.id);
  });

  it("skips a head whose holder then commits its claim, and the head it took stays its owner's", async () => {
    const head = await store.enqueue("sess_1", { type: "user.message", data: {}, sessionThreadId: "t" });
    const lock = await lockHead("sess_1");
    expect(await store.claim("sess_1", "runner-b", 60_000)).toBeNull();
    await harness.pool.query("SELECT 1");
    await lock.commit();
    expect((await store.claim("sess_1", "runner-c", 60_000))?.event.id).toBe(head.id);
  });
});

describe("the pending scan lists claimable heads in arrival order", () => {
  let harness: PgTestHarness;
  let store: PgPendingEventStore;
  beforeAll(async () => { harness = await createPgTestHarness(); });
  afterAll(async () => { await harness.close(); });
  beforeEach(async () => {
    await harness.reset();
    store = new PgPendingEventStore(harness.pool);
  });

  const heads = (topLevel: number, child = 0) => store.listClaimableSessionIds({ topLevel, child });

  it("orders Sessions by their head's arrival, not by id, and lists at most the limit", async () => {
    for (const id of ["sess_c", "sess_a", "sess_b"]) await store.enqueue(id, { type: "m", data: {}, sessionThreadId: "t" });
    // A later input of the first Session does not move its head.
    await store.enqueue("sess_c", { type: "m", data: {}, sessionThreadId: "t" });
    expect(await heads(10)).toEqual(["sess_c", "sess_a", "sess_b"]);
    expect(await heads(2)).toEqual(["sess_c", "sess_a"]);
    // A head under a live claim is passed over; the next Session's head takes its place.
    await store.claim("sess_c", "runner-a", 60_000);
    expect(await heads(2)).toEqual(["sess_a", "sess_b"]);
  });

  it("limits Child Sessions' heads apart from the others', so a top-level backlog never hides one (#328)", async () => {
    const now = new Date();
    const session = (id: string, parent?: string) => harness.pool.query(
      `INSERT INTO sessions (id, tenant_id, agent_id, status, agent, workspace_id, created_at, updated_at, delegation)
       VALUES ($1, 'tenant', 'agent', 'idle', '{}', 'workspace', $2, $2, $3)`,
      [id, now, JSON.stringify(parent ? { parentSessionId: parent } : null)]);
    for (const id of ["top_1", "top_2", "top_3"]) await session(id);
    await session("child_1", "top_1");
    await session("child_2", "top_2");
    for (const id of ["top_1", "top_2", "child_1", "top_3", "child_2"]) await store.enqueue(id, { type: "m", data: {}, sessionThreadId: "t" });
    // A head without a Session row counts as top-level.
    await store.enqueue("missing", { type: "m", data: {}, sessionThreadId: "t" });

    expect(await heads(0, 10)).toEqual(["child_1", "child_2"]);
    expect(await heads(1, 1)).toEqual(["top_1", "child_1"]);
    expect(await heads(10, 10)).toEqual(["top_1", "top_2", "child_1", "top_3", "child_2", "missing"]);
  });
});
