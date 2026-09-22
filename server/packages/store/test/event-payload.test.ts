import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventPayloadCodec, BIG_RESULT_BYTES, lazyEventData } from "../src/event-payload.js";
import { PgEventLogStore } from "../src/postgres/event-log-store.js";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";
import { migrateEventPayloads } from "../src/postgres/migrate-event-payloads.js";
import { createPgStores } from "../src/postgres/index.js";

describe("durable external results", () => {
  let harness: PgTestHarness;
  const objects = new Map<string, Buffer>();
  const put = vi.fn(async (session: string, hash: string, body: Buffer) => { objects.set(`${session}/${hash}`, body); });
  const get = vi.fn(async (session: string, hash: string) => {
    const body = objects.get(`${session}/${hash}`);
    if (!body) throw new Error("Object missing");
    return body;
  });
  const codec = new EventPayloadCodec({ put, get });
  const content = [{ type: "image", source: { type: "base64", mediaType: "image/png", data: "a".repeat(BIG_RESULT_BYTES * 2) } }];
  const result = { id: "result1", toolUseId: "call1", turnId: "turn1", isError: false, content };
  beforeAll(async () => { harness = await createPgTestHarness(); });
  beforeEach(async () => { await harness.reset(); objects.clear(); vi.clearAllMocks(); });
  afterAll(async () => { await harness.close(); });

  it.skipIf(!process.env.PG_TEST_URL)("reproduces PostgreSQL rejection of raw NUL and lone surrogates", async () => {
    await expect(harness.pool.query("SELECT $1::jsonb", [JSON.stringify({ text: "binary\u0000" })]))
      .rejects.toMatchObject({ code: "22P05", message: "unsupported Unicode escape sequence" });
    for (const text of ["broken\ud800", "broken\udfff"]) {
      await expect(harness.pool.query("SELECT $1::jsonb", [JSON.stringify({ text })]))
        .rejects.toMatchObject({ code: "22P02" });
    }
  });

  it.each([
    ["NUL from binary stdout", "ELF\u0000binary"],
    ["lone high surrogate", "before\ud800after"],
    ["lone low surrogate", "before\udfffafter"],
  ])("round-trips small results containing %s through PG and a fresh reader", async (_, text) => {
    const data = { ...result, content: [{ type: "text", text }] };
    expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThan(BIG_RESULT_BYTES);
    const store = new PgEventLogStore(harness.pool, codec);
    for (const type of ["agent.tool_result", "agent.mcp_tool_result"]) {
      const event = { type, data, sessionThreadId: "primary", idempotencyKey: type };
      const first = await store.append("s1", event);
      const raw = (await harness.pool.query("SELECT data FROM events WHERE session_id=$1 AND seq=$2", ["s1", first.seq])).rows[0].data;
      expect(raw).toMatchObject({ toolUseId: "call1", payloadRef: { version: 1 } });
      expect(raw).not.toHaveProperty("content");
      expect(first.data).toEqual(data);
      expect(await store.append("s1", event)).toEqual(first);
    }
    const restored = await new PgEventLogStore(harness.pool, codec).getEvents("s1");
    expect(restored.data.map(event => event.data)).toEqual([data, data]);
    const next = await store.append("s1", { type: "agent.message", data: { text: "continued" }, sessionThreadId: "primary" });
    expect(next.seq).toBe(3);
  });

  it("externalizes unsupported text in nested result keys and values", async () => {
    const data = { ...result, content: [], details: { ["key\u0000"]: [{ text: "value\ud800" }] } };
    const stored = await codec.encode("s1", "agent.tool_result", data);
    expect(stored).toHaveProperty("payloadRef");
    expect(await codec.decode("s1", stored, "agent.tool_result")).toEqual(data);
  });

  it("keeps Chinese, emoji, replacement characters and literal escapes inline", async () => {
    const data = { ...result, content: [{ type: "text", text: "中文 😀 � literal \\u0000 \\ud800 \\udfff\n\t" }] };
    const store = new PgEventLogStore(harness.pool, codec);
    await store.append("s1", { type: "agent.tool_result", data, sessionThreadId: "primary" });
    expect((await store.getEvents("s1")).data[0].data).toEqual(data);
    expect(put).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("stores small binary native results and delegation checkpoints without losing identity or presentation", async () => {
    const native = { id: "pi_entry_binary", type: "agent.context_entry", sdk: "pi@0.83.0", turnId: "turn1",
      entry: { id: "binary", parentId: "assistant", type: "message", timestamp: "2026-09-22T00:00:00Z",
        message: { role: "toolResult", toolCallId: "call1", toolName: "bash", isError: false,
          content: [{ type: "text", text: "ELF\u0000\ud800" }], details: { signature: "unchanged" } } },
      presentation: { version: 1, blocks: [{ type: "agent.tool_result", blockIndex: 3 }] } };
    const checkpoint = { events: [native] };
    const encoded = await codec.checkpoint("s1", checkpoint);
    await harness.pool.query("INSERT INTO delegation_waits (id,record) VALUES ($1,$2)", ["binary_wait", JSON.stringify({ checkpoint: encoded })]);
    const saved = (await harness.pool.query("SELECT record FROM delegation_waits WHERE id=$1", ["binary_wait"])).rows[0].record;
    expect(await codec.checkpoint("s1", saved.checkpoint, true)).toEqual(checkpoint);
    const store = new PgEventLogStore(harness.pool, codec);
    await store.append("s1", { type: native.type, data: native, sessionThreadId: "primary" });
    get.mockClear();
    const reference = (await store.getEvents("s1", { payload: "reference" })).data[0];
    expect(reference.seq).toBe(2);
    expect(reference.data).toMatchObject({ payloadRef: { version: 1 }, presentation: native.presentation,
      entry: { id: "binary", parentId: "assistant", message: { role: "toolResult", toolCallId: "call1", toolName: "bash" } } });
    expect(get).not.toHaveBeenCalled();
    expect((await new PgEventLogStore(harness.pool, codec).getEvents("s1")).data[0].data).toEqual(native);
  });

  it("does not commit an unsafe small result or consume its sequence if object storage fails", async () => {
    const data = { ...result, content: [{ type: "text", text: "binary\u0000" }] };
    const failing = new EventPayloadCodec({ put: async () => { throw new Error("OSS unavailable"); }, get });
    await expect(new PgEventLogStore(harness.pool, failing).append("s1", {
      type: "agent.tool_result", data, sessionThreadId: "primary", idempotencyKey: "binary",
    })).rejects.toThrow("OSS unavailable");
    expect((await harness.pool.query("SELECT * FROM events")).rows).toHaveLength(0);
    const store = new PgEventLogStore(harness.pool, codec);
    expect((await store.append("s1", { type: "agent.tool_result", data, sessionThreadId: "primary", idempotencyKey: "binary" })).seq).toBe(1);
  });

  it("stores only a reference in PG; list reads do not GET OSS; runtime and detail reads restore exact bytes", async () => {
    const store = new PgEventLogStore(harness.pool, codec);
    await store.append("s1", { type: "agent.tool_result", data: result, sessionThreadId: "primary", idempotencyKey: "once" });
    const row = (await harness.pool.query("SELECT data FROM events WHERE session_id='s1'")).rows[0];
    expect(JSON.stringify(row.data).length).toBeLessThan(1024);
    expect(row.data).toMatchObject({ toolUseId: "call1", payloadRef: { version: 1 } });
    get.mockClear();
    const page = await store.getEvents("s1", { payload: "reference" });
    expect(page.data[0].data).toEqual(row.data);
    expect(get).not.toHaveBeenCalled();
    expect((await store.getEvents("s1")).data[0].data).toEqual(result);
    const retry = await store.append("s1", { type: "agent.tool_result", data: result, sessionThreadId: "primary", idempotencyKey: "once" });
    expect(retry.seq).toBe(1);
    expect(retry.data).toEqual(result);
  });

  it("fails before PG append if OSS upload fails", async () => {
    const failing = new EventPayloadCodec({ put: async () => { throw new Error("OSS unavailable"); }, get });
    const store = new PgEventLogStore(harness.pool, failing);
    await expect(store.append("s1", { type: "agent.tool_result", data: result, sessionThreadId: "primary" })).rejects.toThrow("OSS unavailable");
    expect((await harness.pool.query("SELECT * FROM events")).rows).toHaveLength(0);
  });

  it("does not interpret a user's payloadRef field as a Host storage reference", async () => {
    const store = new PgEventLogStore(harness.pool, codec);
    const data = { payloadRef: { version: 1, sha256: "a".repeat(64), bytes: 100000 }, content: "user data" };
    await store.append("s1", { type: "user.message", data, sessionThreadId: "primary" });
    expect((await store.getEvents("s1")).data[0].data).toEqual(data);
    expect(put).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("externalizes native Pi tool results and checkpoint copies without changing entry identity or signatures", async () => {
    const entry = { id: "native1", parentId: "prior", type: "message", timestamp: "2026-09-21T00:00:00Z",
      message: { role: "toolResult", toolCallId: "call1", toolName: "read", content: [{ type: "image", data: "a".repeat(BIG_RESULT_BYTES * 2), mimeType: "image/png" }], details: { signature: "preserve" } } };
    const event = { type: "agent.context_entry", sdk: "pi@0.83.0", entry };
    const encoded = await codec.checkpoint("s1", { events: [result, event], config: { model: "test" } });
    // Only well-typed tool events are transformed.
    const checkpoint = await codec.checkpoint("s1", { events: [{ ...result, type: "agent.tool_result" }, event] });
    expect(JSON.stringify(checkpoint).length).toBeLessThan(2048);
    expect(await codec.checkpoint("s1", checkpoint, true)).toEqual({ events: [{ ...result, type: "agent.tool_result" }, event] });
    expect((encoded.config as { model: string }).model).toBe("test");
  });

  it("rejects missing/corrupt objects rather than passing placeholders to Pi", async () => {
    const data = await codec.encode("s1", "agent.tool_result", result);
    await expect(codec.decode("other-session", data)).rejects.toThrow("Object missing");
    const key = [...objects.keys()][0];
    objects.set(key, Buffer.from("wrong"));
    await expect(codec.decode("s1", data)).rejects.toThrow("integrity");
  });

  it("projects legacy inline results without writing or loading objects, and leaves small results unchanged", () => {
    expect(lazyEventData("agent.tool_result", result)).toHaveProperty("payloadRef");
    expect(lazyEventData("agent.tool_result", { content: "small" })).toEqual({ content: "small" });
    expect(put).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("migrates old events and checkpoint copies with read-back verification and can safely rerun", async () => {
    const original = new PgEventLogStore(harness.pool);
    await original.append("s1", { type: "agent.tool_result", data: result, sessionThreadId: "primary" });
    const checkpoint = { events: [{ ...result, type: "agent.tool_result" }] };
    await harness.pool.query("INSERT INTO delegation_waits (id,record) VALUES ($1,$2)", ["wait1", JSON.stringify({ callerSessionId: "s1", checkpoint })]);
    expect(await migrateEventPayloads(harness.pool, codec)).toMatchObject({ events: 1, checkpoints: 1, updated: 0 });
    expect(put).not.toHaveBeenCalled();
    expect(await migrateEventPayloads(harness.pool, codec, { apply: true, sessionId: "s1" })).toMatchObject({ events: 1, checkpoints: 1, updated: 2, conflicts: 0 });
    expect(get).toHaveBeenCalledTimes(2);
    const store = new PgEventLogStore(harness.pool, codec);
    expect((await store.getEvents("s1")).data[0].data).toEqual(result);
    const record = (await harness.pool.query("SELECT record FROM delegation_waits WHERE id='wait1'")).rows[0].record;
    expect(JSON.stringify(record).length).toBeLessThan(1024);
    expect(await codec.checkpoint("s1", record.checkpoint, true)).toEqual(checkpoint);
    expect(await migrateEventPayloads(harness.pool, codec, { apply: true })).toMatchObject({ events: 0, checkpoints: 0, updated: 0 });
  });

  it("externalizes checkpoints in real delegation transactions and avoids hydrating them for status polling", async () => {
    const stores = await createPgStores(harness.pool, { ensureSchema: false, payloads: codec });
    const agent = await stores.agentStore.create({ tenantId: "t1", name: "Agent", model: "test", system: "", runtime: "pi" });
    const parent = await stores.sessionStore.create({ tenantId: "t1", agentId: agent.id, agent, workspaceId: "w1" });
    await stores.pendingEventStore.enqueue(parent.id, { type: "user.message", data: {}, sessionThreadId: "primary" });
    const claim = (await stores.pendingEventStore.claim!(parent.id, "owner", 60000))!;
    const fence = { eventId: claim.event.id, ownerId: claim.ownerId, generation: claim.generation };
    const checkpoint = { events: [{ ...result, type: "agent.tool_result" }] };
    await stores.delegationStore.accept({ tenantId: "t1", callerSessionId: parent.id, callerTurnId: "turn1", callerToolUseId: "delegate1", prompt: "task", mode: "sync", parentModel: "test", maxSteps: 10, sandboxSessionId: parent.id, checkpoint }, fence);
    const row = (await harness.pool.query("SELECT record FROM delegation_waits")).rows[0].record;
    expect(JSON.stringify(row).length).toBeLessThan(2048);
    get.mockClear();
    await stores.delegationStore.listWaits(parent.id, fence.eventId, { checkpoint: "reference" });
    expect(get).not.toHaveBeenCalled();
    expect((await stores.delegationStore.listWaits(parent.id, fence.eventId))[0].checkpoint).toEqual(checkpoint);
  });
});
