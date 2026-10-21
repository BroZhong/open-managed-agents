import { describe, it, expect } from "vitest";
import type {
  AdapterInput,
  SessionEvent,
  StreamEvent,
} from "@open-managed-agents/adapter-core";
import { MemoryTurnJournal, runWithJournal } from "@open-managed-agents/adapter-core/testing";
import { MockAdapter } from "../src/mock-adapter.js";

// Minimal valid AdapterInput for tests
const INPUT: AdapterInput = {
  sessionId: "test-session",
  turnId: "test-turn",
  message: {
    role: "user",
    content: [{ type: "text", text: "hello" }],
  },
  agent: {
    model: "test-model",
    system: "You are a test agent.",
  },
  history: [],
};

// Everything the adapter wrote through an in-memory Turn journal, in order.
const collectEvents = (adapter: MockAdapter, journal?: MemoryTurnJournal) =>
  runWithJournal(adapter, INPUT, journal);

describe("MockAdapter", () => {
  describe("default event sequence", () => {
    it("writes events in the documented order", async () => {
      const adapter = new MockAdapter();
      const events = await collectEvents(adapter);

      const types = events.map((e) => e.type);
      expect(types).toEqual([
        "span.model_request_start",
        "agent.message_stream_start",
        "agent.message_chunk",
        "agent.message_chunk",
        "agent.message_chunk",
        "agent.message_stream_end",
        "agent.message",
        "span.model_request_end",
      ]);
    });

    it("emits NO session lifecycle events — the Host router owns them (issue #83)", async () => {
      const adapter = new MockAdapter();
      const events = await collectEvents(adapter);
      const types = events.map((e) => e.type);

      // Lifecycle events are the router's sole responsibility; an adapter that
      // also emitted them would double the count in the event log.
      expect(types).not.toContain("session.status_running");
      expect(types).not.toContain("session.status_idle");
    });

    it("includes at least one span pair", async () => {
      const adapter = new MockAdapter();
      const events = await collectEvents(adapter);
      const types = events.map((e) => e.type);

      expect(types).toContain("span.model_request_start");
      expect(types).toContain("span.model_request_end");

      const startIdx = types.indexOf("span.model_request_start");
      const endIdx = types.indexOf("span.model_request_end");
      expect(endIdx).toBeGreaterThan(startIdx);
    });

    it("includes streaming lifecycle (start, chunks, end)", async () => {
      const adapter = new MockAdapter();
      const events = await collectEvents(adapter);
      const types = events.map((e) => e.type);

      const streamStart = types.indexOf("agent.message_stream_start");
      const streamEnd = types.indexOf("agent.message_stream_end");
      expect(streamStart).toBeGreaterThanOrEqual(0);
      expect(streamEnd).toBeGreaterThan(streamStart);

      // All chunks are between start and end
      const chunkIndices = types
        .map((t, i) => (t === "agent.message_chunk" ? i : -1))
        .filter((i) => i >= 0);
      expect(chunkIndices.length).toBeGreaterThanOrEqual(1);
      for (const idx of chunkIndices) {
        expect(idx).toBeGreaterThan(streamStart);
        expect(idx).toBeLessThan(streamEnd);
      }
    });

    it("includes a canonical agent.message event", async () => {
      const adapter = new MockAdapter();
      const events = await collectEvents(adapter);
      const types = events.map((e) => e.type);

      expect(types).toContain("agent.message");
    });

    it("generates unique IDs and valid timestamps for each event", async () => {
      const adapter = new MockAdapter();
      const events = await collectEvents(adapter);

      const ids = events.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length); // all unique

      for (const event of events) {
        expect(event.id).toMatch(/^sevt_/);
        expect(() => new Date(event.timestamp)).not.toThrow();
        expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
      }
    });
  });

  describe("custom events option", () => {
    it("writes the provided events exactly as-is", async () => {
      const customEvents: SessionEvent[] = [
        {
          id: "sevt_custom1",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "session.status_running",
        },
        {
          id: "sevt_custom2",
          timestamp: "2024-01-01T00:00:01.000Z",
          type: "session.status_idle",
        },
      ];

      const adapter = new MockAdapter({ events: customEvents });
      const events = await collectEvents(adapter);

      expect(events).toEqual(customEvents);
    });

    it("writes nothing when events array is empty", async () => {
      const adapter = new MockAdapter({ events: [] });
      const events = await collectEvents(adapter);

      expect(events).toEqual([]);
    });
  });

  describe("delayMs option", () => {
    it("spaces events by the configured interval", async () => {
      const delayMs = 100;
      const customEvents: SessionEvent[] = [
        {
          id: "sevt_d1",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "session.status_running",
        },
        {
          id: "sevt_d2",
          timestamp: "2024-01-01T00:00:01.000Z",
          type: "session.status_idle",
        },
      ];

      const adapter = new MockAdapter({ events: customEvents, delayMs });

      const timestamps: number[] = [];
      const journal = new (class extends MemoryTurnJournal {
        override record(event: Parameters<MemoryTurnJournal["record"]>[0]): void {
          timestamps.push(Date.now());
          super.record(event);
        }
      })();
      await collectEvents(adapter, journal);

      // There should be a delay between the two events
      const gap = timestamps[1]! - timestamps[0]!;
      expect(gap).toBeGreaterThanOrEqual(delayMs - 50);
      expect(gap).toBeLessThanOrEqual(delayMs + 50);
    });

    it("works with delayMs of 0 (no artificial delay)", async () => {
      const adapter = new MockAdapter({ events: [
        {
          id: "sevt_z1",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "session.status_running",
        },
        {
          id: "sevt_z2",
          timestamp: "2024-01-01T00:00:01.000Z",
          type: "session.status_idle",
        },
      ], delayMs: 0 });

      const start = Date.now();
      const events = await collectEvents(adapter);
      const elapsed = Date.now() - start;

      expect(events).toHaveLength(2);
      expect(elapsed).toBeLessThan(50);
    });
  });

  describe("concurrency (statelessness)", () => {
    it("concurrent run() calls on the same instance work independently", async () => {
      const customEvents: SessionEvent[] = [
        {
          id: "sevt_c1",
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "session.status_running",
        },
        {
          id: "sevt_c2",
          timestamp: "2024-01-01T00:00:01.000Z",
          type: "session.status_idle",
        },
      ];

      const adapter = new MockAdapter({ events: customEvents, delayMs: 50 });

      // Run two calls concurrently
      const [events1, events2] = await Promise.all([
        collectEvents(adapter),
        collectEvents(adapter),
      ]);

      // Both should write the full sequence independently
      expect(events1).toEqual(customEvents);
      expect(events2).toEqual(customEvents);
    });

    it("default sequence works correctly across concurrent calls", async () => {
      const adapter = new MockAdapter();

      const [events1, events2] = await Promise.all([
        collectEvents(adapter),
        collectEvents(adapter),
      ]);

      // Both should have the same number of events
      expect(events1).toHaveLength(events2.length);
      // Types should match
      expect(events1.map((e) => e.type)).toEqual(events2.map((e) => e.type));
      // But IDs should be different (independently generated)
      const ids1 = events1.map((e) => e.id);
      const ids2 = events2.map((e) => e.id);
      for (let i = 0; i < ids1.length; i++) {
        expect(ids1[i]).not.toBe(ids2[i]);
      }
    });
  });

  // Until the Router injects a journal, the dev server still reads the stream.
  it("yields the script from run() when no journal is injected", async () => {
    const events: SessionEvent[] = [];
    for await (const event of new MockAdapter().run(INPUT)) events.push(event);
    expect(events.map((e) => e.type)).toEqual([
      "span.model_request_start",
      "agent.message_stream_start",
      "agent.message_chunk",
      "agent.message_chunk",
      "agent.message_chunk",
      "agent.message_stream_end",
      "agent.message",
      "span.model_request_end",
    ]);
  });
});

describe("MockAdapter with an injected Turn journal", () => {
  it("records the Complete Events and streams the Deltas on the message's block, numbered from the Host's base", async () => {
    const journal = new MemoryTurnJournal();
    await runWithJournal(new MockAdapter(), { ...INPUT, blockBase: 4 }, journal);

    expect(journal.deltas.map(({ event, blockIndex }) => [event.type, blockIndex])).toEqual([
      ["agent.message_stream_start", 4],
      ["agent.message_chunk", 4],
      ["agent.message_chunk", 4],
      ["agent.message_chunk", 4],
      ["agent.message_stream_end", 4],
    ]);
    expect(journal.committed.map((e) => e.type)).toEqual([
      "span.model_request_start",
      "agent.message",
      "span.model_request_end",
    ]);
    expect(journal.committed[1]).toMatchObject({ content: [{ type: "text", text: "Hello, world!" }], blockIndex: 4 });
  });

  it("aligns each Complete Event with the latest unclaimed stream of its kind, as the Router did", async () => {
    let n = 0;
    const event = (type: string, extra: Record<string, unknown> = {}) =>
      ({ id: `sevt_a${n++}`, timestamp: "2024-01-01T00:00:00.000Z", type, ...extra }) as SessionEvent;
    const events = [
      event("agent.message", { content: [{ type: "text", text: "unstreamed" }] }),
      event("agent.thinking_stream_start"),
      event("agent.thinking_chunk", { text: "plan" }),
      event("agent.thinking_stream_end"),
      event("agent.thinking", { text: "plan" }),
      // An empty stream lifecycle never completes; it must not steal the next block's completion.
      event("agent.message_stream_start"),
      event("agent.message_stream_end"),
      event("agent.message_stream_start"),
      event("agent.message_chunk", { text: "calling" }),
      event("agent.tool_use_input_stream_start", { toolUseId: "a", name: "bash" }),
      event("agent.tool_use_input_stream_start", { toolUseId: "b", name: "mcp" }),
      event("agent.tool_use_input_chunk", { toolUseId: "a", delta: "{}" }),
      event("agent.message", { content: [{ type: "text", text: "calling" }] }),
      event("agent.mcp_tool_use", { toolUseId: "b", serverName: "web", name: "search", input: {} }),
      event("agent.tool_use", { toolUseId: "a", name: "bash", input: {} }),
      event("agent.tool_result", { toolUseId: "a", content: [] }),
    ];
    const journal = new MemoryTurnJournal();
    await runWithJournal(new MockAdapter({ events }), { ...INPUT, blockBase: 2 }, journal);

    expect(journal.deltas.map(({ event, blockIndex }) => [event.type, blockIndex])).toEqual([
      ["agent.thinking_stream_start", 2],
      ["agent.thinking_chunk", 2],
      ["agent.thinking_stream_end", 2],
      ["agent.message_stream_start", 3],
      ["agent.message_stream_end", 3],
      ["agent.message_stream_start", 4],
      ["agent.message_chunk", 4],
      ["agent.tool_use_input_stream_start", 5],
      ["agent.tool_use_input_stream_start", 6],
      // A Delta joins the latest started block.
      ["agent.tool_use_input_chunk", 6],
    ]);
    expect(journal.committed.map((e) => [e.type, "blockIndex" in e ? e.blockIndex : undefined])).toEqual([
      ["agent.message", undefined],
      ["agent.thinking", 2],
      ["agent.message", 4],
      ["agent.mcp_tool_use", 6],
      ["agent.tool_use", 5],
      ["agent.tool_result", undefined],
    ]);
  });

  it("makes a tool call durable before the tool runs and everything before a model request durable before it starts", async () => {
    let n = 0;
    const event = (type: string, extra: Record<string, unknown> = {}) =>
      ({ id: `sevt_f${n++}`, timestamp: "2024-01-01T00:00:00.000Z", type, ...extra }) as SessionEvent;
    const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const events = [
      event("span.model_request_start", { model: "mock-model" }),
      event("agent.tool_use_input_stream_start", { toolUseId: "a", name: "bash" }),
      event("agent.tool_use_input_stream_end", { toolUseId: "a" }),
      event("agent.tool_use", { toolUseId: "a", name: "bash", input: {} }),
      event("span.model_request_end", { usage }),
      event("agent.tool_result", { toolUseId: "a", content: [] }),
      event("span.model_request_start", { model: "mock-model" }),
      event("agent.message", { content: [{ type: "text", text: "done" }] }),
      event("span.model_request_end", { usage }),
    ];
    const batches: string[][] = [];
    const journal = new MemoryTurnJournal(async (batch) => { batches.push(batch.map((e) => e.type)); });
    await runWithJournal(new MockAdapter({ events }), INPUT, journal);

    expect(batches).toEqual([
      ["span.model_request_start", "agent.tool_use"],
      ["span.model_request_end", "agent.tool_result"],
      ["span.model_request_start", "agent.message", "span.model_request_end"],
    ]);
  });

  it("stops at a failed flush without running the tool, and run() still settles", async () => {
    const events: SessionEvent[] = [
      { id: "sevt_x1", timestamp: "2024-01-01T00:00:00.000Z", type: "agent.tool_use", toolUseId: "a", name: "bash", input: {} },
      { id: "sevt_x2", timestamp: "2024-01-01T00:00:01.000Z", type: "agent.tool_result", toolUseId: "a", content: [] },
    ];
    const journal = new MemoryTurnJournal(async () => { throw new Error("pending claim lease lost"); });
    await runWithJournal(new MockAdapter({ events }), INPUT, journal);

    expect(journal.recorded.map((e) => e.type)).toEqual(["agent.tool_use"]);
    expect(journal.committed).toEqual([]);
  });

  it("ends the script at an Interrupt and still writes what it recorded before", async () => {
    const controller = new AbortController();
    // Interrupt while the message is streaming.
    const journal = new (class extends MemoryTurnJournal {
      override delta(event: StreamEvent, blockIndex: number): void {
        super.delta(event, blockIndex);
        if (event.type === "agent.message_chunk") controller.abort();
      }
    })();
    await runWithJournal(new MockAdapter(), { ...INPUT, signal: controller.signal }, journal);

    expect(journal.deltas.map(({ event }) => event.type)).toEqual(["agent.message_stream_start", "agent.message_chunk"]);
    expect(journal.recorded.map((e) => e.type)).toEqual(["span.model_request_start"]);
    expect(journal.committed.map((e) => e.type)).toEqual(["span.model_request_start"]);
  });
});
