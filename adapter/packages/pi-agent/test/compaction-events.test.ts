import { expect, it } from "vitest";
import { PiEventTranslator } from "../src/translator.js";

it("pairs native compaction retries and completion without inventing missing usage", () => {
  const translator = new PiEventTranslator();
  const start = translator.processEvent({ type: "compaction_start", reason: "threshold" });
  expect(start).toHaveLength(1);
  const retry = translator.processEvent({ type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "503" });
  const end = translator.processEvent({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false, result: { summary: "saved", firstKeptEntryId: "keep", tokensBefore: 200, estimatedTokensAfter: 60 } });
  expect(start[0]).toMatchObject({ type: "agent.compaction", status: "started", reason: "threshold" });
  expect(retry[0]).toMatchObject({ compactionId: (start[0] as {compactionId: string}).compactionId, status: "retrying", attempt: 1 });
  expect(end[0]).toMatchObject({ compactionId: (start[0] as {compactionId: string}).compactionId, status: "completed", summary: "saved", tokensBefore: 200, estimatedTokensAfter: 60 });
  expect(end[0]).not.toHaveProperty("usage");
  const orphanEnd = translator.processEvent({ type: "compaction_end", reason: "overflow", aborted: false, willRetry: false, result: undefined, errorMessage: "recovery failed" });
  expect(orphanEnd[0]).toMatchObject({ status: "failed", errorMessage: "recovery failed" });
  expect((orphanEnd[0] as {compactionId: string}).compactionId).not.toBe((start[0] as {compactionId: string}).compactionId);
});
