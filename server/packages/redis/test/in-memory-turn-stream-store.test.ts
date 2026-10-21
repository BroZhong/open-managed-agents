import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryTurnStreamStore } from "../src/in-memory-turn-stream-store.js";

describe("InMemoryTurnStreamStore", () => {
  let store: InMemoryTurnStreamStore;

  beforeEach(() => {
    store = new InMemoryTurnStreamStore();
  });

  it("E7 CAS refuses an attempt that observed an earlier generation of the Turn", async () => {
    await store.setActiveTurn("s", { turnId: "turn_1_a1", status: "running", generation: 2 });
    expect(await store.compareAndSetActiveTurn("s", { turnId: "turn_1_a1", generation: 1 }, null)).toBe(false);
    expect(await store.compareAndSetActiveTurn("s", { turnId: "turn_1_a1", generation: 1 },
      { turnId: "turn_1_a1", status: "idle", generation: 1 })).toBe(false);
    expect(await store.getActiveTurn("s")).toEqual({ turnId: "turn_1_a1", status: "running", generation: 2 });
    expect(await store.compareAndSetActiveTurn("s", { turnId: "turn_1_a1", generation: 2 }, null)).toBe(true);
    expect(await store.getActiveTurn("s")).toBeNull();
  });

  describe("active-turn status", () => {
    it("reads back a running turn", async () => {
      await store.setActiveTurn("sess_1", { turnId: "turn_1", status: "running", generation: 1 });
      expect(await store.getActiveTurn("sess_1")).toEqual({ turnId: "turn_1", status: "running", generation: 1 });
    });

    it("reads back an idle turn", async () => {
      await store.setActiveTurn("sess_1", { turnId: "turn_1", status: "idle", generation: 1 });
      expect(await store.getActiveTurn("sess_1")).toEqual({ turnId: "turn_1", status: "idle", generation: 1 });
    });

    it("returns null when there is no record", async () => {
      expect(await store.getActiveTurn("sess_missing")).toBeNull();
    });

    it("clears the active-turn record", async () => {
      await store.setActiveTurn("sess_1", { turnId: "turn_1", status: "running", generation: 1 });
      await store.clearActiveTurn("sess_1");
      expect(await store.getActiveTurn("sess_1")).toBeNull();
    });

    it("isolates active turns by session", async () => {
      await store.setActiveTurn("sess_1", { turnId: "turn_1", status: "running", generation: 1 });
      await store.setActiveTurn("sess_2", { turnId: "turn_2", status: "idle", generation: 1 });
      expect((await store.getActiveTurn("sess_1"))?.status).toBe("running");
      expect((await store.getActiveTurn("sess_2"))?.status).toBe("idle");
    });
  });

  describe("delta streams", () => {
    it("appends and reads deltas back in order, with afterId resume", async () => {
      const id0 = await store.appendDelta("session", { turnId: "turn_1", blockIndex: 0, type: "chunk", data: { text: "Hel" } });
      await store.appendDelta("session", { turnId: "turn_1", blockIndex: 0, type: "chunk", data: { text: "lo" } });

      expect(await store.deltaCount("session", "turn_1")).toBe(2);
      const all = await store.readDeltas("session", "turn_1");
      expect(all.map((d) => (d.data as { text: string }).text)).toEqual(["Hel", "lo"]);

      const after = await store.readDeltas("session", "turn_1", id0);
      expect(after).toHaveLength(1);
      expect((after[0].data as { text: string }).text).toBe("lo");
    });

    it("keeps each delta's attempt", async () => {
      await store.appendDelta("session", { turnId: "turn_1", blockIndex: 2, attempt: 1, type: "chunk", data: { text: "lost" } });
      await store.appendDelta("session", { turnId: "turn_1", blockIndex: 2, attempt: 2, type: "chunk", data: { text: "resumed" } });

      expect((await store.readDeltas("session", "turn_1")).map((d) => d.attempt)).toEqual([1, 2]);
    });

    it("reclaims a turn's stream", async () => {
      await store.appendDelta("session", { turnId: "turn_1", blockIndex: 0, type: "chunk", data: null });
      await store.reclaim("session", "turn_1");
      expect(await store.deltaCount("session", "turn_1")).toBe(0);
    });
  });
});
