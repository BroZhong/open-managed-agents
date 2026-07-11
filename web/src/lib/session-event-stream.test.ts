import { describe, expect, it } from "vitest";
import type { SessionDelta, SessionEvent } from "@/lib/types";
import {
  initialSessionEventStreamState,
  parseSessionSseFrame,
  sessionEventStreamReducer,
  sessionEventStreamUrl,
} from "@/lib/session-event-stream";

const userMessage: SessionEvent = {
  seq: 10,
  type: "user.message",
  data: { content: [{ type: "text", text: "Why?" }] },
  ts: "2026-07-11T00:00:00.000Z",
};

function delta(type: string, deltaId: string, data: Record<string, unknown>): SessionDelta {
  return {
    type,
    data,
    ts: "2026-07-11T00:00:01.000Z",
    turnId: "turn_10",
    blockIndex: 0,
    deltaId,
  };
}

describe("session event stream state", () => {
  it("keeps Deltas outside durable history and replaces them with the Complete Event", () => {
    let state = sessionEventStreamReducer(initialSessionEventStreamState, {
      type: "history.loaded",
      events: [userMessage],
    });

    state = sessionEventStreamReducer(state, {
      type: "delta.received",
      delta: delta("agent.message_stream_start", "1-0", {}),
    });
    state = sessionEventStreamReducer(state, {
      type: "delta.received",
      delta: delta("agent.message_chunk", "1-1", { text: "Because" }),
    });

    expect(state.events).toEqual([userMessage]);
    expect(state.activeDeltas).toHaveLength(2);

    const complete: SessionEvent = {
      seq: 11,
      type: "agent.message",
      data: {
        content: [{ type: "text", text: "Because." }],
        turnId: "turn_10",
        blockIndex: 0,
      },
      ts: "2026-07-11T00:00:02.000Z",
    };
    state = sessionEventStreamReducer(state, {
      type: "event.received",
      event: complete,
    });

    expect(state.events).toEqual([userMessage, complete]);
    expect(state.activeDeltas).toEqual([]);
    expect(state.events[1].seq).toBe(11);
  });

  it("deduplicates a Delta replayed with the same deltaId", () => {
    const chunk = delta("agent.message_chunk", "1-1", { text: "Hel" });
    let state = sessionEventStreamReducer(initialSessionEventStreamState, {
      type: "delta.received",
      delta: chunk,
    });
    state = sessionEventStreamReducer(state, {
      type: "delta.received",
      delta: chunk,
    });

    expect(state.activeDeltas).toEqual([chunk]);
  });

  it.each(["session.error", "session.status_idle"])(
    "clears an incomplete Delta when %s ends the live projection",
    (type) => {
      let state = sessionEventStreamReducer(initialSessionEventStreamState, {
        type: "delta.received",
        delta: delta("agent.message_chunk", "1-1", { text: "Partial" }),
      });
      state = sessionEventStreamReducer(state, {
        type: "event.received",
        event: {
          seq: 11,
          type,
          data: type === "session.error" ? { error: { message: "failed" } } : {},
          ts: "2026-07-11T00:00:02.000Z",
        },
      });

      expect(state.activeDeltas).toEqual([]);
    },
  );

  it("does not revive a completed block from stale Redis Deltas on reconnect", () => {
    const complete: SessionEvent = {
      seq: 11,
      type: "agent.message",
      data: {
        content: [{ type: "text", text: "Complete" }],
        turnId: "turn_10",
        blockIndex: 0,
      },
      ts: "2026-07-11T00:00:02.000Z",
    };
    let state = sessionEventStreamReducer(initialSessionEventStreamState, {
      type: "history.loaded",
      events: [userMessage, complete],
    });
    state = sessionEventStreamReducer(state, {
      type: "delta.received",
      delta: delta("agent.message_chunk", "1-1", { text: "Complete" }),
    });

    expect(state.events).toEqual([userMessage, complete]);
    expect(state.activeDeltas).toEqual([]);
  });

  it("projects only the latest incomplete block", () => {
    let state = sessionEventStreamReducer(initialSessionEventStreamState, {
      type: "delta.received",
      delta: delta("agent.thinking_chunk", "1-1", { text: "Thinking" }),
    });
    state = sessionEventStreamReducer(state, {
      type: "delta.received",
      delta: {
        ...delta("agent.message_chunk", "1-2", { text: "Answer" }),
        blockIndex: 1,
      },
    });

    expect(state.activeDeltas).toMatchObject([
      { type: "agent.message_chunk", blockIndex: 1, deltaId: "1-2" },
    ]);
  });

  it.each([
    ["a duplicate", "1-1"],
    ["a delayed unique Delta", "1-3"],
  ])("does not let %s from an older block replace the latest block", (_case, deltaId) => {
    let state = sessionEventStreamReducer(initialSessionEventStreamState, {
      type: "delta.received",
      delta: delta("agent.thinking_chunk", "1-1", { text: "Old" }),
    });
    state = sessionEventStreamReducer(state, {
      type: "delta.received",
      delta: {
        ...delta("agent.message_chunk", "1-2", { text: "Latest" }),
        blockIndex: 1,
      },
    });
    state = sessionEventStreamReducer(state, {
      type: "delta.received",
      delta: delta("agent.thinking_chunk", deltaId, { text: "Old again" }),
    });

    expect(state.activeDeltas).toMatchObject([
      { type: "agent.message_chunk", blockIndex: 1, deltaId: "1-2" },
    ]);
  });

  it("scopes deltaId deduplication to one Turn", () => {
    let state = sessionEventStreamReducer(initialSessionEventStreamState, {
      type: "delta.received",
      delta: delta("agent.message_chunk", "1-1", { text: "First Turn" }),
    });
    state = sessionEventStreamReducer(state, {
      type: "event.received",
      event: {
        seq: 11,
        type: "session.status_idle",
        data: {},
        ts: "2026-07-11T00:00:02.000Z",
      },
    });
    state = sessionEventStreamReducer(state, {
      type: "delta.received",
      delta: {
        ...delta("agent.message_chunk", "1-1", { text: "Second Turn" }),
        turnId: "turn_20",
      },
    });

    expect(state.activeDeltas).toMatchObject([
      { turnId: "turn_20", deltaId: "1-1", data: { text: "Second Turn" } },
    ]);
  });

  it("replaces a crashed attempt's partial Delta when a new claim generation starts", () => {
    let state = sessionEventStreamReducer(initialSessionEventStreamState, {
      type: "delta.received",
      delta: {
        ...delta("agent.message_chunk", "1-1", { text: "Hel" }),
        turnId: "turn_10_a1",
      },
    });
    state = sessionEventStreamReducer(state, {
      type: "delta.received",
      delta: {
        ...delta("agent.message_chunk", "1-1", { text: "Hello" }),
        turnId: "turn_10_a2",
      },
    });

    expect(state.activeDeltas).toMatchObject([
      { turnId: "turn_10_a2", deltaId: "1-1", data: { text: "Hello" } },
    ]);
  });
});

describe("parseSessionSseFrame", () => {
  it("parses an id-less aligned frame as a Delta without fabricating seq", () => {
    const parsed = parseSessionSseFrame(
      'event: agent.message_chunk\ndata: {"type":"agent.message_chunk","text":"Hel","timestamp":"2026-07-11T00:00:01.000Z","turnId":"turn_10","blockIndex":0,"deltaId":"1-1"}',
    );

    expect(parsed).toEqual({
      kind: "delta",
      delta: {
        type: "agent.message_chunk",
        data: {
          type: "agent.message_chunk",
          text: "Hel",
          timestamp: "2026-07-11T00:00:01.000Z",
          turnId: "turn_10",
          blockIndex: 0,
          deltaId: "1-1",
        },
        ts: "2026-07-11T00:00:01.000Z",
        turnId: "turn_10",
        blockIndex: 0,
        deltaId: "1-1",
      },
    });
    if (!parsed || parsed.kind !== "delta") throw new Error("expected Delta frame");
    expect("seq" in parsed.delta).toBe(false);
  });

  it("parses an id-bearing frame as a durable event with its original seq", () => {
    const parsed = parseSessionSseFrame(
      'event: agent.message\nid: 11\ndata: {"type":"agent.message","content":[{"type":"text","text":"Hello"}],"turnId":"turn_10","blockIndex":0}',
    );

    expect(parsed).toMatchObject({
      kind: "event",
      event: {
        seq: 11,
        type: "agent.message",
        data: { turnId: "turn_10", blockIndex: 0 },
      },
    });
  });
});

describe("sessionEventStreamUrl", () => {
  it("opts the live subscription into Delta frames", () => {
    expect(sessionEventStreamUrl("http://localhost:3000", "sess_1")).toBe(
      "http://localhost:3000/v1/sessions/sess_1/events?include=chunks",
    );
  });
});
