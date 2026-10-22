import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgSessionCleanupStore } from "../src/index.js";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";

let harness: PgTestHarness;

/** Sweep once and report whether the Session's cleanup was attempted. */
async function attempted(store: PgSessionCleanupStore, outcome: boolean | Error): Promise<boolean> {
  let called = false;
  await store.sweep(async () => {
    called = true;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  return called;
}

// The retry schedule is checked on a faked clock, which pg-mem's NOW() follows
// and a real server's does not.
describe.skipIf(Boolean(process.env.PG_TEST_URL))("PgSessionCleanupStore.sweep", () => {
  beforeEach(async () => {
    harness ??= await createPgTestHarness({ allowUnsupportedLockSyntax: true });
    await harness.reset();
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-22T00:00:00Z") });
    await harness.pool.query("INSERT INTO session_cleanup (session_id, retry_at) VALUES ('sess_stuck', $1)", [new Date()]);
  });
  afterEach(() => { vi.useRealTimers(); });
  afterAll(async () => { await harness?.close(); });

  it("backs off a cleanup that keeps failing: 5 s, 10 s, 20 s, … up to 10 minutes", async () => {
    const store = new PgSessionCleanupStore(harness.pool);
    const expectedDelays = [5, 10, 20, 40, 80, 160, 320, 600, 600];
    expect(await attempted(store, false)).toBe(true);
    for (const delay of expectedDelays) {
      vi.advanceTimersByTime(delay * 1000 - 100);
      expect(await attempted(store, false), `retried before ${delay} s`).toBe(false);
      vi.advanceTimersByTime(100);
      expect(await attempted(store, new Error("gateway unavailable")), `not retried after ${delay} s`).toBe(true);
    }
  });

  it("never retries a completed cleanup", async () => {
    const store = new PgSessionCleanupStore(harness.pool);
    expect(await attempted(store, true)).toBe(true);
    vi.advanceTimersByTime(3_600_000);
    expect(await attempted(store, true)).toBe(false);
  });
});
