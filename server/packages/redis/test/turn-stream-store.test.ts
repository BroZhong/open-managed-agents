import { describe, it, expect, beforeEach } from "vitest";
import { RedisTurnStreamStore } from "../src/turn-stream-store.js";
import { FakeRedis } from "./fake-redis.js";

describe("RedisTurnStreamStore", () => {
  let redis: FakeRedis;
  let store: RedisTurnStreamStore;

  beforeEach(() => {
    redis = new FakeRedis();
    store = new RedisTurnStreamStore(redis);
  });

  it("CAS does not let a stale turn overwrite or clear a newer active turn", async () => {
    await store.setActiveTurn("s", { turnId: "turn_1_a2", status: "running" });

    expect(await store.compareAndSetActiveTurn(
      "s",
      "turn_1_a1",
      { turnId: "turn_1_a1", status: "idle" },
    )).toBe(false);
    expect(await store.compareAndSetActiveTurn("s", "turn_1_a1", null)).toBe(false);
    expect(await store.getActiveTurn("s")).toEqual({
      turnId: "turn_1_a2",
      status: "running",
    });
    expect(await store.compareAndSetActiveTurn(
      "s",
      "turn_1_a2",
      { turnId: "turn_1_a2", status: "idle" },
    )).toBe(true);
  });

  describe("delta streams", () => {
    it("appends deltas to the per-turn stream and reads them back with turnId + blockIndex", async () => {
      await store.appendDelta({
        turnId: "turn_1",
        blockIndex: 0,
        type: "agent.message_chunk",
        data: { type: "agent.message_chunk", text: "Hel" },
      });
      await store.appendDelta({
        turnId: "turn_1",
        blockIndex: 0,
        type: "agent.message_chunk",
        data: { type: "agent.message_chunk", text: "lo" },
      });

      const deltas = await store.readDeltas("turn_1");
      expect(deltas).toHaveLength(2);
      expect(deltas[0].turnId).toBe("turn_1");
      expect(deltas[0].blockIndex).toBe(0);
      expect(deltas[0].type).toBe("agent.message_chunk");
      expect((deltas[0].data as { text: string }).text).toBe("Hel");
      expect((deltas[1].data as { text: string }).text).toBe("lo");
    });

    it("writes deltas to stream:turn:{turnId} — a per-turn Redis key", async () => {
      await store.appendDelta({ turnId: "turn_42", blockIndex: 0, type: "agent.message_chunk", data: {} });
      expect(redis.hasStream("stream:turn:turn_42")).toBe(true);
    });

    it("preserves blockIndex across content blocks within a turn", async () => {
      await store.appendDelta({ turnId: "t", blockIndex: 0, type: "agent.message_chunk", data: { text: "a" } });
      await store.appendDelta({ turnId: "t", blockIndex: 1, type: "agent.thinking_chunk", data: { text: "b" } });

      const deltas = await store.readDeltas("t");
      expect(deltas.map((d) => d.blockIndex)).toEqual([0, 1]);
    });

    it("readDeltas(afterId) resumes exclusively after a stream entry id", async () => {
      const firstId = await store.appendDelta({ turnId: "t", blockIndex: 0, type: "c", data: { n: 1 } });
      await store.appendDelta({ turnId: "t", blockIndex: 0, type: "c", data: { n: 2 } });

      const rest = await store.readDeltas("t", firstId);
      expect(rest).toHaveLength(1);
      expect((rest[0].data as { n: number }).n).toBe(2);
    });

    it("deltaCount reports the number of buffered deltas", async () => {
      expect(await store.deltaCount("t")).toBe(0);
      await store.appendDelta({ turnId: "t", blockIndex: 0, type: "c", data: {} });
      await store.appendDelta({ turnId: "t", blockIndex: 0, type: "c", data: {} });
      expect(await store.deltaCount("t")).toBe(2);
    });

    it("reclaim deletes the per-turn stream", async () => {
      await store.appendDelta({ turnId: "t", blockIndex: 0, type: "c", data: {} });
      expect(redis.hasStream("stream:turn:t")).toBe(true);

      await store.reclaim("t");

      expect(redis.hasStream("stream:turn:t")).toBe(false);
      expect(await store.deltaCount("t")).toBe(0);
      expect(await store.readDeltas("t")).toEqual([]);
    });
  });

  describe("active-turn map", () => {
    it("stores and reads the active turn for a session", async () => {
      await store.setActiveTurn("sess_1", { turnId: "turn_1", status: "running" });
      expect(await store.getActiveTurn("sess_1")).toEqual({ turnId: "turn_1", status: "running" });
    });

    it("returns null when no active turn is recorded", async () => {
      expect(await store.getActiveTurn("sess_none")).toBeNull();
    });

    it("overwrites status on the same turn", async () => {
      await store.setActiveTurn("sess_1", { turnId: "turn_1", status: "running" });
      await store.setActiveTurn("sess_1", { turnId: "turn_1", status: "idle" });
      expect(await store.getActiveTurn("sess_1")).toEqual({ turnId: "turn_1", status: "idle" });
    });

    it("clearActiveTurn removes the record", async () => {
      await store.setActiveTurn("sess_1", { turnId: "turn_1", status: "running" });
      await store.clearActiveTurn("sess_1");
      expect(await store.getActiveTurn("sess_1")).toBeNull();
    });

    it("keeps active-turn records independent per session", async () => {
      await store.setActiveTurn("sess_a", { turnId: "turn_a", status: "running" });
      await store.setActiveTurn("sess_b", { turnId: "turn_b", status: "idle" });
      expect(await store.getActiveTurn("sess_a")).toEqual({ turnId: "turn_a", status: "running" });
      expect(await store.getActiveTurn("sess_b")).toEqual({ turnId: "turn_b", status: "idle" });
    });
  });
});
