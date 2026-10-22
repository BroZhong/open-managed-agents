import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PgPendingEventStore } from "../src/postgres/pending-event-store.js";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";

/**
 * D7: an Interrupt targets the Session's running Turn, whether or not a
 * Runner holds its claim right now: a Turn whose Runner was lost or handed
 * it over still runs as far as the user can tell. The next claim applies it.
 * pg-mem cannot run requestInterrupt's NOT EXISTS, so this needs PostgreSQL.
 */
describe.skipIf(!process.env.PG_TEST_URL)("PgPendingEventStore Interrupt acceptance", () => {
  let harness: PgTestHarness;
  let store: PgPendingEventStore;
  const input = { type: "user.message", data: {}, sessionThreadId: "sthr_primary" };

  beforeAll(async () => { harness = await createPgTestHarness(); });
  afterAll(async () => { await harness.close(); });
  beforeEach(async () => { await harness.reset(); store = new PgPendingEventStore(harness.pool); });

  it("D7 accepts an Interrupt for a head whose claim lapsed, and reports it to the claim that takes over", async () => {
    const event = await store.enqueue("sess", input);
    await store.claim("sess", "lost-runner", 60_000);
    await harness.pool.query(`UPDATE pending_events SET claim_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [event.id]);
    expect(await store.requestInterrupt("sess")).toBe(true);
    expect(await store.claim("sess", "takeover", 60_000)).toMatchObject({ generation: 2, previous: "expired", priorInterrupt: true });
  });

  it("D7 accepts an Interrupt for a head whose claim was released, and reports it to the next claim", async () => {
    await store.enqueue("sess", input);
    const handedOver = (await store.claim("sess", "stopping-runner", 60_000))!;
    await store.releaseClaim("sess", handedOver.event.id, handedOver);
    expect(await store.requestInterrupt("sess")).toBe(true);
    expect(await store.claim("sess", "takeover", 60_000)).toMatchObject({ generation: 2, previous: "released", priorInterrupt: true });
  });

  it("refuses an Interrupt while no Turn has claimed the head, and once its Turn completed", async () => {
    expect(await store.requestInterrupt("sess")).toBe(false);
    const event = await store.enqueue("sess", input);
    expect(await store.requestInterrupt("sess")).toBe(false);
    const claim = (await store.claim("sess", "runner", 60_000))!;
    expect(claim.priorInterrupt).toBe(false);
    await harness.pool.query(`UPDATE pending_events SET claim_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [event.id]);
    await harness.pool.query(`INSERT INTO events (session_id, seq, type, data, ts, session_thread_id) VALUES ('sess', 1, 'session.turn_completed', $1, now(), 'sthr_primary')`,
      [JSON.stringify({ pendingEventId: event.id, turnId: "turn_1_a1" })]);
    expect(await store.requestInterrupt("sess")).toBe(false);
  });
});
