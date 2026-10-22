import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createRedisClient } from "../src/index.js";
import { RedisTurnStreamStore } from "../src/turn-stream-store.js";

// Opt-in: runs the Lua scripts on a real, disposable Redis. Each test flushes
// database 15 of REDIS_TEST_URL, so never point it at a shared instance.
const url = process.env.REDIS_TEST_URL;
const turn = (inputSeq: number, generation: number, status: "running" | "idle" = "running") =>
  ({ turnId: `turn_${inputSeq}_a1`, status, inputSeq, generation });

describe.skipIf(!url)("RedisTurnStreamStore on a real Redis", () => {
  const redis = createRedisClient({ url, db: 15 });
  const store = new RedisTurnStreamStore(redis);
  beforeEach(async () => { await redis.flushdb(); });
  afterAll(async () => { await redis.quit(); });

  it("E7 refuses an older generation and an earlier input, and accepts the newest writer", async () => {
    await store.recordActiveTurn("s", turn(1, 2));
    expect(await store.recordActiveTurn("s", turn(1, 1, "idle"))).toBe(false);
    expect(await store.clearActiveTurn("s", { inputSeq: 1, generation: 1 })).toBe(false);
    expect(await store.recordActiveTurn("s", turn(5, 1))).toBe(true);
    expect(await store.recordActiveTurn("s", turn(1, 3))).toBe(false);
    expect(await store.getActiveTurn("s")).toEqual(turn(5, 1));
    expect(await store.clearActiveTurn("s", { inputSeq: 5, generation: 1 })).toBe(true);
    expect(await store.getActiveTurn("s")).toBeNull();
  });

  it("reads a projection written without input seq or generation as the earliest", async () => {
    await redis.hset("session:active-turn:s", { turnId: "turn_9", status: "running" });
    expect(await store.recordActiveTurn("s", turn(1, 1))).toBe(true);
    expect(await store.getActiveTurn("s")).toEqual(turn(1, 1));
  });

  it("appends a Delta with its attempt and refreshes the stream's 30-minute expiry on every append", async () => {
    const key = "stream:session:s:turn:t";
    await store.appendDelta("s", { turnId: "t", blockIndex: 0, attempt: 2, type: "agent.message_chunk", data: { text: "a" } });
    await redis.pexpire(key, 1_000);
    await store.appendDelta("s", { turnId: "t", blockIndex: 1, attempt: 2, type: "agent.message_chunk", data: { text: "b" } });
    const ttl = await redis.pttl(key);
    expect(ttl).toBeGreaterThan(30 * 60_000 - 5_000);
    expect(ttl).toBeLessThanOrEqual(30 * 60_000);
    const deltas = await store.readDeltas("s", "t");
    expect(deltas.map(({ blockIndex, attempt, data }) => ({ blockIndex, attempt, data }))).toEqual([
      { blockIndex: 0, attempt: 2, data: { text: "a" } },
      { blockIndex: 1, attempt: 2, data: { text: "b" } },
    ]);
  });
});
