import { expect, it } from "vitest";
import { EventPayloadCodec, PgEventLogStore, presentEvent, presentEventPage } from "../src/index.js";
import { createPgTestHarness } from "./pg-harness.js";

const assistant = {
  type: "agent.context_entry", id: "pi_entry_a", sdk: "pi@0.83.0", timestamp: "2026-09-21T00:00:00Z", turnId: "turn1",
  entry: { id: "a", parentId: null, type: "message", message: { role: "assistant", provider: "test", api: "test", model: "test", stopReason: "toolUse", content: [
    { type: "thinking", thinking: "plan", thinkingSignature: "native-only" },
    { type: "text", text: "reading" },
    { type: "toolCall", id: "call1", name: "read", arguments: { path: "image.png" } },
  ] } },
  presentation: { version: 1, blocks: [{ type: "agent.thinking", index: 0, blockIndex: 0 }, { type: "agent.message", index: 1, blockIndex: 1 }, { type: "agent.tool_use", index: 2, blockIndex: 2 }] },
};

it("persists one native row, allocates stable cursors for every display block and resumes inside a row", async () => {
  const h = await createPgTestHarness();
  try {
    const store = new PgEventLogStore(h.pool);
    const first = await store.append("s1", { type: assistant.type, data: assistant, sessionThreadId: "primary", idempotencyKey: "once" });
    expect(first.seq).toBe(4);
    expect((await h.pool.query("SELECT * FROM events")).rows).toHaveLength(1);
    expect((await store.append("s1", { type: assistant.type, data: assistant, sessionThreadId: "primary", idempotencyKey: "once" })).seq).toBe(4);
    const displayed = presentEvent(first);
    expect(displayed.map(e => [e.seq, e.type])).toEqual([[1, "agent.thinking"], [2, "agent.message"], [3, "agent.tool_use"], [4, "agent.context_entry"]]);
    expect(displayed[2].data).toMatchObject({ toolUseId: "call1", input: { path: "image.png" }, blockIndex: 2 });
    const page = presentEventPage(await store.getEvents("s1", { afterSeq: 2, limit: 1 }), 2, 1);
    expect(page.data.map(e => e.seq)).toEqual([3]); expect(page.hasMore).toBe(true);
    const end = presentEventPage(await store.getEvents("s1", { afterSeq: 3, limit: 1 }), 3, 1);
    expect(end.data.map(e => e.seq)).toEqual([4]); expect(end.hasMore).toBe(false);
    expect((await store.append("s1", { type: "session.status_idle", data: {}, sessionThreadId: "primary" })).seq).toBe(5);
  } finally { await h.close(); }
});

it("shares a single OSS result between native restoration and lazy display, with no object reads for lists", async () => {
  const h = await createPgTestHarness();
  try {
    const objects = new Map<string, Buffer>(); let reads = 0;
    const codec = new EventPayloadCodec({ put: async (_, key, bytes) => { objects.set(key, bytes); }, get: async (_, key) => { reads++; return objects.get(key)!; } });
    const store = new PgEventLogStore(h.pool, codec);
    const image = { type: "image", mimeType: "image/png", data: "A".repeat(100000) };
    const data = { ...assistant, id: "pi_entry_b", entry: { id: "b", parentId: "a", type: "message", message: { role: "toolResult", toolCallId: "call1", toolName: "read", isError: false, content: [image] } },
      presentation: { version: 1, blocks: [{ type: "agent.tool_result" }] } };
    await store.append("s1", { type: data.type, data, sessionThreadId: "primary" });
    expect(objects.size).toBe(1);
    const rows = (await store.getEvents("s1", { payload: "reference" })).data;
    const displayed = rows.flatMap(row => presentEvent(row));
    expect(reads).toBe(0);
    expect(JSON.stringify(displayed).length).toBeLessThan(2000);
    expect(displayed[0].data).toMatchObject({ toolUseId: "call1", payloadRef: { version: 1 } });
    const restored = (await store.getEvents("s1")).data[0];
    expect(restored.data).toEqual(data);
    expect(presentEvent(restored)[0].data).toMatchObject({ content: [{ type: "image", source: { type: "base64", data: image.data, mediaType: image.mimeType } }] });
    expect(reads).toBe(1);
  } finally { await h.close(); }
});

it("does not project old native rows that already have separate display events", () => {
  const { presentation, ...legacy } = assistant;
  void presentation;
  const row = { type: legacy.type, seq: 1, data: legacy };
  expect(presentEvent(row)).toEqual([row]);
});
