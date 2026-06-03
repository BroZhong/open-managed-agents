import { describe, it, expect } from "vitest";
import type {
  AdapterInput,
  SessionEvent,
} from "@open-managed-agents/adapter-core";
import { MockAdapter } from "../src/mock-adapter.js";

// Helper to collect all events from the async iterable
async function collectEvents(
  iterable: AsyncIterable<SessionEvent>,
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

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

describe("MockAdapter", () => {
  describe("default event sequence", () => {
    it("yields events in the documented order", async () => {
      const adapter = new MockAdapter();
      const events = await collectEvents(adapter.run(INPUT));

      const types = events.map((e) => e.type);
      expect(types).toEqual([
        "session.status_running",
        "span.model_request_start",
        "agent.message_stream_start",
        "agent.message_chunk",
        "agent.message_chunk",
        "agent.message_chunk",
        "agent.message_stream_end",
        "agent.message",
        "span.model_request_end",
        "session.status_idle",
      ]);
    });

    it("starts with session.status_running and ends with session.status_idle", async () => {
      const adapter = new MockAdapter();
      const events = await collectEvents(adapter.run(INPUT));

      expect(events[0]!.type).toBe("session.status_running");
      expect(events[events.length - 1]!.type).toBe("session.status_idle");
    });

    it("includes at least one span pair", async () => {
      const adapter = new MockAdapter();
      const events = await collectEvents(adapter.run(INPUT));
      const types = events.map((e) => e.type);

      expect(types).toContain("span.model_request_start");
      expect(types).toContain("span.model_request_end");

      const startIdx = types.indexOf("span.model_request_start");
      const endIdx = types.indexOf("span.model_request_end");
      expect(endIdx).toBeGreaterThan(startIdx);
    });

    it("includes streaming lifecycle (start, chunks, end)", async () => {
      const adapter = new MockAdapter();
      const events = await collectEvents(adapter.run(INPUT));
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
      const events = await collectEvents(adapter.run(INPUT));
      const types = events.map((e) => e.type);

      expect(types).toContain("agent.message");
    });

    it("generates unique IDs and valid timestamps for each event", async () => {
      const adapter = new MockAdapter();
      const events = await collectEvents(adapter.run(INPUT));

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
    it("yields the provided events exactly as-is", async () => {
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
      const events = await collectEvents(adapter.run(INPUT));

      expect(events).toEqual(customEvents);
    });

    it("yields an empty sequence when events array is empty", async () => {
      const adapter = new MockAdapter({ events: [] });
      const events = await collectEvents(adapter.run(INPUT));

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
      for await (const _event of adapter.run(INPUT)) {
        timestamps.push(Date.now());
      }

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
      const events = await collectEvents(adapter.run(INPUT));
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
        collectEvents(adapter.run(INPUT)),
        collectEvents(adapter.run(INPUT)),
      ]);

      // Both should yield the full sequence independently
      expect(events1).toEqual(customEvents);
      expect(events2).toEqual(customEvents);
    });

    it("default sequence works correctly across concurrent calls", async () => {
      const adapter = new MockAdapter();

      const [events1, events2] = await Promise.all([
        collectEvents(adapter.run(INPUT)),
        collectEvents(adapter.run(INPUT)),
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
});
