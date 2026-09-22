import { expect, it } from "vitest";
import { BIG_RESULT_BYTES, EventPayloadCodec, PgEventLogStore } from "@oma-server/store";
import { createPgTestHarness } from "../../store/test/pg-harness.js";
import { restorePiSession } from "../../../../adapter/packages/pi-agent/src/pi-context.js";

it("restores the same native Pi context and compaction boundary after externalizing display and native tool results", async () => {
  const harness = await createPgTestHarness();
  try {
    const original = restorePiSession([]);
    original.appendMessage({ role: "user", content: "old", timestamp: 1 });
    const kept = original.appendMessage({ role: "user", content: "inspect image", timestamp: 2 });
    original.appendMessage({ role: "assistant", api: "openai-completions", provider: "openai", model: "test", timestamp: 3,
      content: [{ type: "toolCall", id: "read1", name: "read", arguments: { path: "image.png" } }], stopReason: "toolUse",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const image = { type: "image" as const, mimeType: "image/png", data: "A".repeat(BIG_RESULT_BYTES * 2) };
    original.appendMessage({ role: "toolResult", toolCallId: "read1", toolName: "read", content: [image], isError: false, timestamp: 4 });
    original.appendCompaction("Summary of old context", kept, 12345);
    const objects = new Map<string, Buffer>();
    const codec = new EventPayloadCodec({ put: async (s, h, b) => { objects.set(`${s}/${h}`, b); }, get: async (s, h) => objects.get(`${s}/${h}`)! });
    const store = new PgEventLogStore(harness.pool, codec);
    for (const entry of original.getEntries()) {
      await store.append("sess_test", { type: "agent.context_entry", data: { id: `pi_entry_${entry.id}`, type: "agent.context_entry", timestamp: entry.timestamp, sdk: "pi@0.83.0", turnId: "turn1", entry }, sessionThreadId: "primary" });
    }
    await store.append("sess_test", { type: "agent.tool_result", data: { id: "display1", type: "agent.tool_result", toolUseId: "read1", turnId: "turn1", content: [{ type: "image", source: { type: "base64", mediaType: image.mimeType, data: image.data } }], isError: false }, sessionThreadId: "primary" });
    const raw = (await harness.pool.query("SELECT data FROM events")).rows;
    expect(JSON.stringify(raw).length).toBeLessThan(5000);
    // Fresh reader models Host restart; no warm byte cache is needed.
    const history = (await new PgEventLogStore(harness.pool, codec).getEvents("sess_test", { limit: 100 })).data.map(e => e.data);
    const restored = restorePiSession(history as Parameters<typeof restorePiSession>[0]);
    expect(restored.getEntries().map(e => e.id)).toEqual(original.getEntries().map(e => e.id));
    expect(restored.buildSessionContext()).toEqual(original.buildSessionContext());
  } finally { await harness.close(); }
});
