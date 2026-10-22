import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PgEventLogStore } from "../src/postgres/event-log-store.js";
import { PgPendingEventStore } from "../src/postgres/pending-event-store.js";
import { PendingEventClaimLostError } from "../src/errors.js";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";

/**
 * E11: every lease decision (claim, renewal, the fence of a write) is
 * PostgreSQL's, by its clock_timestamp(), so Runners whose clocks disagree
 * with it or with each other still agree on who owns a Turn. A Runner's
 * clock is skewed here by faking Date in the test process; pg-mem's clock is
 * that same Date, so only a real PostgreSQL can tell the difference.
 */
describe.skipIf(!process.env.PG_TEST_URL)("leases are judged by PostgreSQL's clock, not the Runner's (E11)", () => {
  let harness: PgTestHarness;
  let pending: PgPendingEventStore;
  let events: PgEventLogStore;
  const HOUR = 3_600_000;

  beforeAll(async () => { harness = await createPgTestHarness(); });
  afterAll(async () => { await harness.close(); });
  beforeEach(async () => {
    await harness.reset();
    pending = new PgPendingEventStore(harness.pool);
    events = new PgEventLogStore(harness.pool);
    const now = new Date();
    await harness.pool.query(
      `INSERT INTO sessions (id, tenant_id, agent_id, status, agent, workspace_id, created_at, updated_at)
       VALUES ('sess_1', 'tenant_1', 'agent_1', 'running', $1, 'workspace_1', $2, $2)`,
      [JSON.stringify({ id: "agent_1", tenantId: "tenant_1", name: "Agent", model: "model", system: "system", runtime: "mock", createdAt: now, updatedAt: now }), now],
    );
  });
  afterEach(() => { vi.useRealTimers(); });

  /** The Runner's own clock, `offsetMs` away from the real one. */
  const skew = (offsetMs: number) => vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + offsetMs });
  const write = (fence: { eventId: string; ownerId: string; generation: number }, text: string) =>
    events.append("sess_1", { type: "agent.message", data: { text }, sessionThreadId: "sthr_primary", pendingFence: fence });

  it("E11 a Runner whose clock runs an hour ahead cannot take a live claim, and the owner, whose clock lags an hour, keeps renewing and writing", async () => {
    const input = await pending.enqueue("sess_1", { type: "user.message", data: {}, sessionThreadId: "sthr_primary" });
    const owner = (await pending.claim("sess_1", "runner-a", 30_000))!;
    const fence = { eventId: input.id, ownerId: owner.ownerId, generation: owner.generation };

    skew(HOUR);
    expect(await pending.claim("sess_1", "runner-b", 30_000)).toBeNull();
    expect(await pending.listClaimableSessionIds()).not.toContain("sess_1");
    expect(await pending.headClaimable("sess_1")).toBe(false);

    skew(-HOUR);
    expect(await pending.renewClaim("sess_1", input.id, owner, 30_000)).toEqual({ renewed: true, interruptRequested: false });
    await expect(write(fence, "the owner's answer")).resolves.toMatchObject({ type: "agent.message" });
  });

  it("E11 a claim whose lease PostgreSQL says expired is taken over by a Runner whose clock lags an hour, and the old owner, whose clock runs ahead, is fenced out", async () => {
    const input = await pending.enqueue("sess_1", { type: "user.message", data: {}, sessionThreadId: "sthr_primary" });
    const lost = (await pending.claim("sess_1", "runner-a", 30_000))!;
    // The lease runs out by PostgreSQL's clock.
    await harness.pool.query(`UPDATE pending_events SET claim_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [input.id]);

    skew(-HOUR);
    expect(await pending.listClaimableSessionIds()).toContain("sess_1");
    const takeover = await pending.claim("sess_1", "runner-b", 30_000);
    expect(takeover).toMatchObject({ ownerId: "runner-b", generation: lost.generation + 1, previous: "expired" });

    skew(HOUR);
    expect((await pending.renewClaim("sess_1", input.id, lost, 30_000)).renewed).toBe(false);
    await expect(write({ eventId: input.id, ownerId: lost.ownerId, generation: lost.generation }, "the zombie's answer"))
      .rejects.toBeInstanceOf(PendingEventClaimLostError);
    expect(await pending.ack("sess_1", input.id, lost)).toBe(false);
  });
});
