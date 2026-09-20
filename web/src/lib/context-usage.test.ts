import { expect, it } from "vitest";
import { latestContextUsage } from "./context-usage";
import type { SessionEvent } from "./types";

const snapshot = (data: unknown): SessionEvent => ({ seq: 1, type: "agent.context_usage", data, ts: "" });
const valid = snapshot({ tokens: 800, contextWindow: 1000, source: "sdk" });

it.each([null, {}, { tokens: -1, contextWindow: 1000, source: "sdk" }, { tokens: 100, contextWindow: 0, source: "sdk" }, { tokens: Infinity, contextWindow: 1000, source: "sdk" }])("handles unavailable or invalid snapshots: %j", data => {
  expect(latestContextUsage([snapshot(data)]).tokens).toBeNull();
});

it("does not carry pre-compaction usage across a committed native boundary", () => {
  expect(latestContextUsage([valid, { seq: 2, type: "agent.context_entry", data: { entry: { type: "compaction" } }, ts: "" }])).toMatchObject({ tokens: null, contextWindow: 1000, source: "unknown" });
});

it("keeps zero distinct from unknown and replaces a previous known snapshot with unknown", () => {
  expect(latestContextUsage([snapshot({ tokens: 0, contextWindow: 1000, source: "sdk" })]).tokens).toBe(0);
  expect(latestContextUsage([valid, snapshot({ tokens: null, contextWindow: null, source: "unknown" })])).toMatchObject({ tokens: null, contextWindow: null });
});
