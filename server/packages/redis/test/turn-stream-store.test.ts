import { describe, it, expect, beforeEach, vi } from "vitest";
import { RedisTurnStreamStore } from "../src/turn-stream-store.js";
import { BestEffortTurnStreamStore } from "../src/best-effort-turn-stream-store.js";
import { FakeRedis } from "./fake-redis.js";

describe("RedisTurnStreamStore", () => {
  let redis: FakeRedis;
  let store: RedisTurnStreamStore;

  beforeEach(() => {
    redis = new FakeRedis();
    store = new RedisTurnStreamStore(redis);
  });

  it("E7 CAS refuses an attempt that observed an earlier generation of the Turn", async () => {
    // Generation 2 took the Turn over after generation 1 last read the projection.
    await store.setActiveTurn("s", { turnId: "turn_1_a1", status: "running", generation: 2 });

    const stale = { turnId: "turn_1_a1", generation: 1 };
    expect(await store.compareAndSetActiveTurn("s", stale, { turnId: "turn_1_a1", status: "idle", generation: 1 })).toBe(false);
    expect(await store.compareAndSetActiveTurn("s", stale, null)).toBe(false);
    expect(await store.getActiveTurn("s")).toEqual({ turnId: "turn_1_a1", status: "running", generation: 2 });

    const current = { turnId: "turn_1_a1", generation: 2 };
    expect(await store.compareAndSetActiveTurn("s", current, { turnId: "turn_1_a1", status: "idle", generation: 2 })).toBe(true);
    expect(await store.getActiveTurn("s")).toEqual({ turnId: "turn_1_a1", status: "idle", generation: 2 });
    expect(await store.compareAndSetActiveTurn("s", current, null)).toBe(true);
    expect(await store.getActiveTurn("s")).toBeNull();
  });

  it("CAS from no projection succeeds only while there is none", async () => {
    const next = { turnId: "turn_1_a1", status: "running", generation: 1 } as const;
    expect(await store.compareAndSetActiveTurn("s", null, next)).toBe(true);
    expect(await store.compareAndSetActiveTurn("s", null, { ...next, generation: 2 })).toBe(false);
    expect(await store.getActiveTurn("s")).toEqual(next);
  });

  it("reads a projection recorded without a generation as generation 0, and replaces it", async () => {
    await redis.hset("session:active-turn:s", "turnId", "turn_1", "status", "idle");
    const projection = await store.getActiveTurn("s");
    expect(projection).toEqual({ turnId: "turn_1", status: "idle", generation: 0 });
    expect(await store.compareAndSetActiveTurn("s", projection, { turnId: "turn_2_a1", status: "running", generation: 1 })).toBe(true);
    expect(await store.getActiveTurn("s")).toEqual({ turnId: "turn_2_a1", status: "running", generation: 1 });
  });

  describe("delta streams", () => {
    it("appends deltas to the per-turn stream and reads them back with turnId + blockIndex", async () => {
      await store.appendDelta("session", {
        turnId: "turn_1",
        blockIndex: 0,
        type: "agent.message_chunk",
        data: { type: "agent.message_chunk", text: "Hel" },
      });
      await store.appendDelta("session", {
        turnId: "turn_1",
        blockIndex: 0,
        type: "agent.message_chunk",
        data: { type: "agent.message_chunk", text: "lo" },
      });

      const deltas = await store.readDeltas("session", "turn_1");
      expect(deltas).toHaveLength(2);
      expect(deltas[0].turnId).toBe("turn_1");
      expect(deltas[0].blockIndex).toBe(0);
      expect(deltas[0].type).toBe("agent.message_chunk");
      expect((deltas[0].data as { text: string }).text).toBe("Hel");
      expect((deltas[1].data as { text: string }).text).toBe("lo");
    });

    it("keeps each delta's attempt, so attempts sharing a Turn's stream stay apart", async () => {
      await store.appendDelta("session", { turnId: "turn_1", blockIndex: 2, attempt: 1, type: "agent.message_chunk", data: { text: "lost" } });
      await store.appendDelta("session", { turnId: "turn_1", blockIndex: 2, attempt: 2, type: "agent.message_chunk", data: { text: "resumed" } });

      expect((await store.readDeltas("session", "turn_1")).map(({ blockIndex, attempt, data }) => ({ blockIndex, attempt, data }))).toEqual([
        { blockIndex: 2, attempt: 1, data: { text: "lost" } },
        { blockIndex: 2, attempt: 2, data: { text: "resumed" } },
      ]);
    });

    it("writes deltas to stream:session:{sessionId}:turn:{turnId} — a per-turn Redis key", async () => {
      await store.appendDelta("session", { turnId: "turn_42", blockIndex: 0, type: "agent.message_chunk", data: {} });
      expect(redis.hasStream("stream:session:session:turn:turn_42")).toBe(true);
    });

    it("preserves blockIndex across content blocks within a turn", async () => {
      await store.appendDelta("session", { turnId: "t", blockIndex: 0, type: "agent.message_chunk", data: { text: "a" } });
      await store.appendDelta("session", { turnId: "t", blockIndex: 1, type: "agent.thinking_chunk", data: { text: "b" } });

      const deltas = await store.readDeltas("session", "t");
      expect(deltas.map((d) => d.blockIndex)).toEqual([0, 1]);
    });

    it("readDeltas(afterId) resumes exclusively after a stream entry id", async () => {
      const firstId = await store.appendDelta("session", { turnId: "t", blockIndex: 0, type: "c", data: { n: 1 } });
      await store.appendDelta("session", { turnId: "t", blockIndex: 0, type: "c", data: { n: 2 } });

      const rest = await store.readDeltas("session", "t", firstId);
      expect(rest).toHaveLength(1);
      expect((rest[0].data as { n: number }).n).toBe(2);
    });

    it("deltaCount reports the number of buffered deltas", async () => {
      expect(await store.deltaCount("session", "t")).toBe(0);
      await store.appendDelta("session", { turnId: "t", blockIndex: 0, type: "c", data: {} });
      await store.appendDelta("session", { turnId: "t", blockIndex: 0, type: "c", data: {} });
      expect(await store.deltaCount("session", "t")).toBe(2);
    });

    it("reclaim deletes the per-turn stream", async () => {
      await store.appendDelta("session", { turnId: "t", blockIndex: 0, type: "c", data: {} });
      expect(redis.hasStream("stream:session:session:turn:t")).toBe(true);

      await store.reclaim("session", "t");

      expect(redis.hasStream("stream:session:session:turn:t")).toBe(false);
      expect(await store.deltaCount("session", "t")).toBe(0);
      expect(await store.readDeltas("session", "t")).toEqual([]);
    });
  });

  describe("delta stream expiry", () => {
    const MINUTE = 60_000;
    let now: number;

    beforeEach(() => {
      now = 1_700_000_000_000;
      redis = new FakeRedis(() => now);
      store = new RedisTurnStreamStore(redis);
    });

    const append = (n: number) =>
      store.appendDelta("session", { turnId: "t", blockIndex: 0, type: "agent.message_chunk", data: { n } });

    it("expires a Turn's stream 30 minutes after its last append", async () => {
      await append(1);

      now += 30 * MINUTE - 1;
      expect(await store.deltaCount("session", "t")).toBe(1);

      now += 2;
      expect(await store.deltaCount("session", "t")).toBe(0);
      expect(await store.readDeltas("session", "t")).toEqual([]);
    });

    it("refreshes the expiry on every append, so a Turn that keeps streaming never expires mid-way", async () => {
      await append(1);
      for (const n of [2, 3, 4]) {
        // Any two gaps together exceed 30 minutes, so each append must refresh.
        now += 29 * MINUTE;
        await append(n);
      }

      // 87 minutes after the first delta, the whole Turn is still buffered.
      expect((await store.readDeltas("session", "t")).map((d) => d.data)).toEqual([
        { n: 1 },
        { n: 2 },
        { n: 3 },
        { n: 4 },
      ]);

      now += 30 * MINUTE + 1;
      expect(await store.deltaCount("session", "t")).toBe(0);
    });

    it("replays a reconnect within the TTL unchanged, and reads do not extend it", async () => {
      const firstId = await append(1);
      await append(2);

      now += 29 * MINUTE;
      const all = await store.readDeltas("session", "t");
      expect(all.map((d) => d.data)).toEqual([{ n: 1 }, { n: 2 }]);
      expect(all[0]).toMatchObject({ id: firstId, turnId: "t", blockIndex: 0, type: "agent.message_chunk" });
      expect((await store.readDeltas("session", "t", firstId)).map((d) => d.data)).toEqual([{ n: 2 }]);
      expect(await store.deltaCount("session", "t")).toBe(2);

      // Only appends keep a stream alive; a reconnecting reader must not pin an orphan.
      now += MINUTE + 1;
      expect(await store.readDeltas("session", "t")).toEqual([]);
    });
  });

  describe("when Redis is unavailable", () => {
    it("appends stay best-effort: they resolve without a delta id instead of failing the Turn", async () => {
      const delta = { turnId: "t", blockIndex: 0, type: "agent.message_chunk", data: {} };
      vi.spyOn(redis, "eval").mockRejectedValue(new Error("Command timed out"));
      expect(await new BestEffortTurnStreamStore(store, () => true).appendDelta("session", delta)).toBe("");
      expect(await new BestEffortTurnStreamStore(store, () => false).appendDelta("session", delta)).toBe("");
      expect(redis.eval).toHaveBeenCalledTimes(1);
    });
  });

  describe("active-turn map", () => {
    it("stores and reads the active turn for a session", async () => {
      await store.setActiveTurn("sess_1", { turnId: "turn_1", status: "running", generation: 1 });
      expect(await store.getActiveTurn("sess_1")).toEqual({ turnId: "turn_1", status: "running", generation: 1 });
    });

    it("returns null when no active turn is recorded", async () => {
      expect(await store.getActiveTurn("sess_none")).toBeNull();
    });

    it("overwrites status on the same turn", async () => {
      await store.setActiveTurn("sess_1", { turnId: "turn_1", status: "running", generation: 1 });
      await store.setActiveTurn("sess_1", { turnId: "turn_1", status: "idle", generation: 1 });
      expect(await store.getActiveTurn("sess_1")).toEqual({ turnId: "turn_1", status: "idle", generation: 1 });
    });

    it("clearActiveTurn removes the record", async () => {
      await store.setActiveTurn("sess_1", { turnId: "turn_1", status: "running", generation: 1 });
      await store.clearActiveTurn("sess_1");
      expect(await store.getActiveTurn("sess_1")).toBeNull();
    });

    it("keeps active-turn records independent per session", async () => {
      await store.setActiveTurn("sess_a", { turnId: "turn_a", status: "running", generation: 1 });
      await store.setActiveTurn("sess_b", { turnId: "turn_b", status: "idle", generation: 3 });
      expect(await store.getActiveTurn("sess_a")).toEqual({ turnId: "turn_a", status: "running", generation: 1 });
      expect(await store.getActiveTurn("sess_b")).toEqual({ turnId: "turn_b", status: "idle", generation: 3 });
    });
  });
});
