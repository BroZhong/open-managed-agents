import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryTurnStreamStore } from "../src/in-memory-turn-stream-store.js";

describe("InMemoryTurnStreamStore", () => {
  let store: InMemoryTurnStreamStore;

  beforeEach(() => {
    store = new InMemoryTurnStreamStore();
  });

  it("CAS protects a newer active turn from stale cleanup", async () => {
    await store.setActiveTurn("s", { turnId: "turn_1_a2", status: "running" });
    expect(await store.compareAndSetActiveTurn("s", "turn_1_a1", null)).toBe(false);
    expect(await store.getActiveTurn("s")).toEqual({
      turnId: "turn_1_a2",
      status: "running",
    });
  });

  describe("active-turn status", () => {
    it("reads back a running turn", async () => {
      await store.setActiveTurn("sess_1", { turnId: "turn_1", status: "running" });
      expect(await store.getActiveTurn("sess_1")).toEqual({ turnId: "turn_1", status: "running" });
    });

    it("reads back an idle turn", async () => {
      await store.setActiveTurn("sess_1", { turnId: "turn_1", status: "idle" });
      expect(await store.getActiveTurn("sess_1")).toEqual({ turnId: "turn_1", status: "idle" });
    });

    it("returns null when there is no record", async () => {
      expect(await store.getActiveTurn("sess_missing")).toBeNull();
    });

    it("clears the active-turn record", async () => {
      await store.setActiveTurn("sess_1", { turnId: "turn_1", status: "running" });
      await store.clearActiveTurn("sess_1");
      expect(await store.getActiveTurn("sess_1")).toBeNull();
    });

    it("isolates active turns by session", async () => {
      await store.setActiveTurn("sess_1", { turnId: "turn_1", status: "running" });
      await store.setActiveTurn("sess_2", { turnId: "turn_2", status: "idle" });
      expect((await store.getActiveTurn("sess_1"))?.status).toBe("running");
      expect((await store.getActiveTurn("sess_2"))?.status).toBe("idle");
    });
  });

  describe("delta streams", () => {
    it("appends and reads deltas back in order, with afterId resume", async () => {
      const id0 = await store.appendDelta({ turnId: "turn_1", blockIndex: 0, type: "chunk", data: { text: "Hel" } });
      await store.appendDelta({ turnId: "turn_1", blockIndex: 0, type: "chunk", data: { text: "lo" } });

      expect(await store.deltaCount("turn_1")).toBe(2);
      const all = await store.readDeltas("turn_1");
      expect(all.map((d) => (d.data as { text: string }).text)).toEqual(["Hel", "lo"]);

      const after = await store.readDeltas("turn_1", id0);
      expect(after).toHaveLength(1);
      expect((after[0].data as { text: string }).text).toBe("lo");
    });

    it("reclaims a turn's stream", async () => {
      await store.appendDelta({ turnId: "turn_1", blockIndex: 0, type: "chunk", data: null });
      await store.reclaim("turn_1");
      expect(await store.deltaCount("turn_1")).toBe(0);
    });
  });
});
