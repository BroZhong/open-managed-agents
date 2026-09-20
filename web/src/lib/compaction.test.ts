import { expect, it } from "vitest";
import { processEventsToMessages } from "./conversation-projection";
import type { SessionEvent } from "./types";
const event = (seq: number, type: string, data: object): SessionEvent => ({ seq, type, data, ts: "2026-09-20T00:00:00Z" });
it("shows one durable compaction even if Host exits after committing and before SDK end", () => {
  const events = [
    event(1, "agent.compaction", { compactionId: "c1", status: "started", reason: "threshold", turnId: "t1" }),
    event(2, "agent.context_entry", { compactionId: "c1", reason: "threshold", turnId: "t1", entry: { id: "entry1", type: "compaction", summary: "Durable summary", tokensBefore: 123 } }),
  ];
  const messages = processEventsToMessages([...events, ...events]).messages;
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ role: "compaction", status: "completed", text: "Durable summary" });
  const refreshed = processEventsToMessages(JSON.parse(JSON.stringify(events))).messages;
  expect(refreshed).toEqual(messages);
});
it("does not report unmatched failures or abandoned starts as success", () => {
  const messages = processEventsToMessages([
    event(1, "agent.compaction", { compactionId: "c1", status: "started", reason: "threshold", turnId: "t1" }),
    event(2, "session.turn_completed", { turnId: "t1" }),
    event(3, "agent.compaction", { compactionId: "c2", status: "failed", reason: "overflow", errorMessage: "recovery failed" }),
  ]).messages.filter(m => m.role === "compaction");
  expect(messages.map(m => m.status)).toEqual(["interrupted", "failed"]);
});
it.each(["failed", "cancelled"])("keeps a committed summary completed after a later %s acknowledgement", status => {
  const messages = processEventsToMessages([
    event(1, "agent.compaction", { compactionId: "c1", status: "started", reason: "threshold", turnId: "t1" }),
    event(2, "agent.context_entry", { compactionId: "c1", entry: { id: "entry1", type: "compaction", summary: "Durable summary", tokensBefore: 123 } }),
    event(3, "agent.compaction", { compactionId: "c1", status, errorMessage: "acknowledgement lost" }),
  ]).messages;
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ role: "compaction", status: "completed", text: "Durable summary" });
  expect(messages[0].compaction?.errorMessage).toBeUndefined();
  expect(messages[0].compaction?.completionWarning).toBe("acknowledgement lost");
});
