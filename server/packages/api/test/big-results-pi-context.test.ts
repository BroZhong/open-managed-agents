import { expect, it } from "vitest";
import { BIG_RESULT_BYTES, createPgStores, EventPayloadCodec, PgEventLogStore } from "@oma-server/store";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { SessionRouter } from "@oma-server/session-router";
import type { Adapter } from "@open-managed-agents/adapter-core";
import { createPgTestHarness } from "../../store/test/pg-harness.js";
import { restorePiSession } from "../../../../adapter/packages/pi-agent/src/pi-context.js";

it.each([
  { name: "large image", content: { type: "image" as const, mimeType: "image/png", data: "A".repeat(BIG_RESULT_BYTES * 2) } },
  { name: "small binary stdout", content: { type: "text" as const, text: "ELF\u0000binary\ud800\udfff\ud800" } },
])("restores native Pi context and compaction after externalizing $name", async ({ content }) => {
  const harness = await createPgTestHarness();
  try {
    const original = restorePiSession([]);
    original.appendMessage({ role: "user", content: "old", timestamp: 1 });
    const kept = original.appendMessage({ role: "user", content: "inspect image", timestamp: 2 });
    original.appendMessage({ role: "assistant", api: "openai-completions", provider: "openai", model: "test", timestamp: 3,
      content: [{ type: "toolCall", id: "read1", name: "read", arguments: { path: "image.png" } }], stopReason: "toolUse",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    original.appendMessage({ role: "toolResult", toolCallId: "read1", toolName: "read", content: [content], isError: false, timestamp: 4 });
    original.appendCompaction("Summary of old context", kept, 12345);
    const objects = new Map<string, Buffer>();
    const codec = new EventPayloadCodec({ put: async (s, h, b) => { objects.set(`${s}/${h}`, b); }, get: async (s, h) => objects.get(`${s}/${h}`)! });
    const store = new PgEventLogStore(harness.pool, codec);
    for (const entry of original.getEntries()) {
      await store.append("sess_test", { type: "agent.context_entry", data: { id: `pi_entry_${entry.id}`, type: "agent.context_entry", timestamp: entry.timestamp, sdk: "pi@0.83.0", turnId: "turn1", entry }, sessionThreadId: "primary" });
    }
    const displayContent = content.type === "image"
      ? { type: "image", source: { type: "base64", mediaType: content.mimeType, data: content.data } } : content;
    await store.append("sess_test", { type: "agent.tool_result", data: { id: "display1", type: "agent.tool_result", toolUseId: "read1", turnId: "turn1", content: [displayContent], isError: false }, sessionThreadId: "primary" });
    const raw = (await harness.pool.query("SELECT data FROM events")).rows;
    expect(JSON.stringify(raw).length).toBeLessThan(5000);
    expect(objects.size).toBe(2);
    // Fresh reader models Host restart; no warm byte cache is needed.
    const history = (await new PgEventLogStore(harness.pool, codec).getEvents("sess_test", { limit: 100 })).data.map(e => e.data);
    const restored = restorePiSession(history as Parameters<typeof restorePiSession>[0]);
    expect(restored.getEntries().map(e => e.id)).toEqual(original.getEntries().map(e => e.id));
    expect(restored.buildSessionContext()).toEqual(original.buildSessionContext());
  } finally { await harness.close(); }
});

it("continues a Turn after persisting binary tool output instead of emitting adapter_error", async () => {
  const harness = await createPgTestHarness();
  try {
    const objects = new Map<string, Buffer>();
    const codec = new EventPayloadCodec({ put: async (s, h, b) => { objects.set(`${s}/${h}`, b); }, get: async (s, h) => objects.get(`${s}/${h}`)! });
    const stores = await createPgStores(harness.pool, { ensureSchema: false, payloads: codec });
    const agent = await stores.agentStore.create({ tenantId: "owner", name: "Binary reader", model: "test", system: "", runtime: "mock", sandbox: { enabled: false } });
    const session = await stores.sessionStore.create({ tenantId: "owner", agentId: agent.id, agent, workspaceId: "workspace" });
    const content = [{ type: "text" as const, text: "ELF\u0000binary" }];
    let executions = 0;
    const adapter: Adapter = {
      async *run() {
        executions++;
        const timestamp = new Date().toISOString();
        yield { id: "call", timestamp, type: "agent.tool_use", toolUseId: "bash1", name: "bash", input: { command: "head binary" } };
        yield { id: "result", timestamp, type: "agent.tool_result", toolUseId: "bash1", content, isError: false };
        yield { id: "native", timestamp, type: "agent.context_entry", sdk: "pi@0.83.0",
          entry: { id: "native", parentId: null, type: "message", timestamp,
            message: { role: "toolResult", toolCallId: "bash1", toolName: "bash", content, isError: false, timestamp: Date.now() } } };
        yield { id: "finished", timestamp, type: "agent.message", content: [{ type: "text", text: "continued after binary output" }] };
      },
    };
    const router = new SessionRouter({ eventLogStore: stores.eventLogStore, pendingEventStore: stores.pendingEventStore,
      sessionStore: stores.sessionStore, eventStreamHub: new InProcessEventStreamHub(), resolveAdapter: () => adapter });
    await stores.pendingEventStore.enqueue(session.id, { type: "user.message", data: { content: [{ type: "text", text: "inspect" }] }, sessionThreadId: "primary" });
    await router.handleNewEvent(session.id, agent);
    const history = (await stores.eventLogStore.getEvents(session.id, { limit: 100 })).data;
    expect(history.filter(event => event.type === "session.error")).toEqual([]);
    expect(history.find(event => event.type === "agent.tool_result")?.data).toMatchObject({ content });
    expect(history.find(event => event.type === "agent.message")?.data).toMatchObject({ content: [{ type: "text", text: "continued after binary output" }] });
    expect(history.at(-2)?.type).toBe("session.turn_completed");
    expect(history.at(-1)?.type).toBe("session.status_idle");
    expect(executions).toBe(1);
    expect(objects.size).toBe(2);
  } finally { await harness.close(); }
});
