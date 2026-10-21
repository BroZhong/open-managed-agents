import { describe, expect, it } from "vitest";
import type { SessionDelta, SessionEvent } from "@/lib/types";
import {
  initialSessionEventStreamState,
  parseSessionSseFrame,
  sessionEventStreamReducer,
  sessionEventStreamUrl,
  type SessionEventStreamState,
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

  it.each(["session.error", "session.status_idle", "session.status_terminated"])(
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

  it("keeps every incomplete block in the current Turn until its Complete Event arrives", () => {
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
      { type: "agent.thinking_chunk", blockIndex: 0, deltaId: "1-1" },
      { type: "agent.message_chunk", blockIndex: 1, deltaId: "1-2" },
    ]);
  });

  it("deduplicates a replay without dropping a delayed unique Delta from an older block", () => {
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
      delta: delta("agent.thinking_chunk", "1-1", { text: "Replay" }),
    });
    state = sessionEventStreamReducer(state, {
      type: "delta.received",
      delta: delta("agent.thinking_chunk", "1-3", { text: " delayed" }),
    });

    expect(state.activeDeltas).toMatchObject([
      { type: "agent.thinking_chunk", blockIndex: 0, deltaId: "1-1" },
      { type: "agent.message_chunk", blockIndex: 1, deltaId: "1-2" },
      { type: "agent.thinking_chunk", blockIndex: 0, deltaId: "1-3" },
    ]);
  });

  it("removes only the completed block while a later block keeps streaming", () => {
    let state = sessionEventStreamReducer(initialSessionEventStreamState, {
      type: "delta.received",
      delta: delta("agent.message_chunk", "1-1", { text: "Before tool" }),
    });
    state = sessionEventStreamReducer(state, {
      type: "delta.received",
      delta: {
        ...delta("agent.tool_use_input_stream_start", "1-2", {
          toolUseId: "tool_1",
          name: "read",
        }),
        blockIndex: 1,
      },
    });
    state = sessionEventStreamReducer(state, {
      type: "event.received",
      event: {
        seq: 11,
        type: "agent.message",
        data: {
          content: [{ type: "text", text: "Before tool" }],
          turnId: "turn_10",
          blockIndex: 0,
        },
        ts: "2026-07-11T00:00:02.000Z",
      },
    });

    expect(state.activeDeltas).toMatchObject([
      { type: "agent.tool_use_input_stream_start", blockIndex: 1 },
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

describe("Delta attempts of one Turn", () => {
  const attempt = (n: number | undefined, type: string, deltaId: string, data: Record<string, unknown>, blockIndex = 0): SessionDelta =>
    ({ ...delta(type, deltaId, data), blockIndex, ...(n === undefined ? {} : { attempt: n }) });
  const receive = (state: SessionEventStreamState, ...deltas: SessionDelta[]) =>
    deltas.reduce((next, item) => sessionEventStreamReducer(next, { type: "delta.received", delta: item }), state);
  const committedThinking: SessionEvent = {
    seq: 11,
    type: "agent.thinking",
    data: { text: "Plan", turnId: "turn_10", blockIndex: 0 },
    ts: "2026-07-11T00:00:02.000Z",
  };

  it("drops a lost attempt's incomplete Deltas once a higher attempt streams the same Turn", () => {
    let state = receive(initialSessionEventStreamState,
      attempt(1, "agent.thinking_chunk", "1-1", { text: "Plan" }, 0),
    );
    state = sessionEventStreamReducer(state, { type: "event.received", event: committedThinking });
    // Attempt 1 is lost while streaming block 1; attempt 2 numbers its first
    // block after the committed one, so it streams block 1 again.
    state = receive(state,
      attempt(1, "agent.message_chunk", "1-2", { text: "Hel" }, 1),
      attempt(1, "agent.message_chunk", "1-3", { text: "lo wor" }, 1),
      attempt(2, "agent.message_chunk", "1-4", { text: "Hi" }, 1),
    );

    expect(state.events).toEqual([committedThinking]);
    expect(state.activeDeltas).toMatchObject([
      { attempt: 2, blockIndex: 1, deltaId: "1-4", data: { text: "Hi" } },
    ]);
  });

  it("ignores a lower attempt's Deltas that arrive after a higher attempt took over the Turn", () => {
    const state = receive(initialSessionEventStreamState,
      attempt(2, "agent.message_chunk", "1-4", { text: "Hi" }, 1),
      // The lost Runner's last publications, and its Redis entries on replay.
      attempt(1, "agent.message_chunk", "1-3", { text: "lo wor" }, 1),
      attempt(1, "agent.thinking_chunk", "1-5", { text: "stale" }, 2),
      attempt(2, "agent.message_chunk", "1-6", { text: " there" }, 1),
    );

    expect(state.activeDeltas.map(({ attempt, deltaId }) => ({ attempt, deltaId }))).toEqual([
      { attempt: 2, deltaId: "1-4" },
      { attempt: 2, deltaId: "1-6" },
    ]);
  });

  it("keeps only the highest attempt of a Delta snapshot that holds two attempts", () => {
    const resumed = attempt(2, "agent.message_chunk", "1-3", { text: "Hi" }, 1);
    const state = sessionEventStreamReducer(initialSessionEventStreamState, {
      type: "deltas.loaded",
      deltas: [
        attempt(1, "agent.message_chunk", "1-1", { text: "Hel" }, 1),
        attempt(1, "agent.message_chunk", "1-2", { text: "lo" }, 1),
        resumed,
      ],
    });

    expect(state.activeDeltas).toEqual([resumed]);
  });

  it("counts a Delta without attempt as the earliest attempt", () => {
    const unversioned = attempt(undefined, "agent.message_chunk", "1-1", { text: "old Runner" });
    const resumed = attempt(1, "agent.message_chunk", "1-2", { text: "resumed" });

    expect(receive(initialSessionEventStreamState, unversioned, resumed).activeDeltas).toEqual([resumed]);
    expect(receive(initialSessionEventStreamState, resumed, unversioned).activeDeltas).toEqual([resumed]);
  });

  it("projects a Turn streamed by one attempt exactly as a Turn without attempts", () => {
    const stream = (n: number | undefined) => [
      attempt(n, "agent.thinking_chunk", "1-1", { text: "Plan" }, 0),
      attempt(n, "agent.message_chunk", "1-2", { text: "Hel" }, 1),
      attempt(n, "agent.message_chunk", "1-3", { text: "lo" }, 1),
    ];
    const project = (n: number | undefined) => {
      let state = receive(initialSessionEventStreamState, ...stream(n));
      state = sessionEventStreamReducer(state, { type: "event.received", event: committedThinking });
      return state.activeDeltas.map(({ attempt: _attempt, ...rest }) => rest);
    };

    expect(project(1)).toEqual(project(undefined));
    expect(project(1)).toMatchObject([
      { blockIndex: 1, deltaId: "1-2", data: { text: "Hel" } },
      { blockIndex: 1, deltaId: "1-3", data: { text: "lo" } },
    ]);
  });

  it("still replaces only the completed block of the highest attempt with its Complete Event", () => {
    let state = receive(initialSessionEventStreamState,
      attempt(1, "agent.message_chunk", "1-1", { text: "lost" }, 1),
      attempt(2, "agent.message_chunk", "1-2", { text: "Answer" }, 1),
      attempt(2, "agent.tool_use_input_stream_start", "1-3", { toolUseId: "tool_1", name: "read" }, 2),
    );
    state = sessionEventStreamReducer(state, {
      type: "event.received",
      event: { seq: 12, type: "agent.message", data: { content: [{ type: "text", text: "Answer" }], turnId: "turn_10", blockIndex: 1 }, ts: "2026-07-11T00:00:03.000Z" },
    });

    expect(state.activeDeltas).toMatchObject([{ attempt: 2, blockIndex: 2, deltaId: "1-3" }]);
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

  it("reads the attempt of a Delta frame, and leaves it unset when the frame has none", () => {
    const frame = (fields: Record<string, unknown>) => parseSessionSseFrame(
      `event: agent.message_chunk\ndata: ${JSON.stringify({ text: "Hi", turnId: "turn_10", blockIndex: 1, deltaId: "1-4", ...fields })}`,
    );

    expect(frame({ attempt: 2 })).toMatchObject({ kind: "delta", delta: { turnId: "turn_10", blockIndex: 1, attempt: 2 } });
    const unversioned = frame({});
    if (unversioned?.kind !== "delta") throw new Error("expected Delta frame");
    expect(unversioned.delta.attempt).toBeUndefined();
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

  it.each([
    { payload: { ts: "2026-07-14T01:00:00.000Z", data: {} }, timestamp: "2026-07-14T01:00:00.000Z" },
    { payload: { timestamp: "2026-07-14T02:00:00.000Z" }, timestamp: "2026-07-14T02:00:00.000Z" },
    { payload: {}, timestamp: undefined },
    { payload: { ts: "invalid" }, timestamp: undefined },
    { payload: { data: { ts: "2026-07-14T03:00:00.000Z" } }, timestamp: undefined },
  ])("distinguishes supplied lifecycle timestamps from display fallbacks: $payload", ({ payload, timestamp }) => {
    const parsed = parseSessionSseFrame(`event: session.status_running\nid: 1\ndata: ${JSON.stringify(payload)}`);
    expect(parsed?.kind).toBe("event");
    if (parsed?.kind === "event") expect(parsed.timestamp).toBe(timestamp);
  });
});

describe("sessionEventStreamUrl", () => {
  it("opts the live subscription into Delta frames", () => {
    expect(sessionEventStreamUrl("http://localhost:3000", "sess_1")).toBe(
      "http://localhost:3000/v1/sessions/sess_1/events?include=chunks",
    );
  });
});

it("deduplicates durable compaction frames across reconnect and history refresh", () => {
  const parsed = parseSessionSseFrame('event: agent.compaction\nid: 12\ndata: {"type":"agent.compaction","compactionId":"c1","status":"completed","summary":"saved"}');
  if (parsed?.kind !== "event") throw new Error("Expected durable compaction");
  let state = sessionEventStreamReducer(initialSessionEventStreamState, { type: "history.loaded", events: [parsed.event] });
  state = sessionEventStreamReducer(state, { type: "event.received", event: parsed.event });
  expect(state.events).toHaveLength(1);
  expect(state.events[0].data).toMatchObject({ summary: "saved" });
});

it("ends only the completed Turn and rejects its late and reconnected Deltas", () => {
  const completion: SessionEvent = { seq: 20, type: "session.turn_completed", data: { turnId: "turn_10" }, ts: userMessage.ts };
  const old = delta("agent.message_chunk", "1-1", { text: "unfinished A" });
  const next = { ...old, turnId: "turn_20", data: { text: "B" } };
  let state = sessionEventStreamReducer(initialSessionEventStreamState, { type: "delta.received", delta: old });
  state = sessionEventStreamReducer(state, { type: "event.received", event: completion });
  expect(state.activeDeltas).toEqual([]);
  state = sessionEventStreamReducer(state, { type: "delta.received", delta: next });
  state = sessionEventStreamReducer(state, { type: "event.received", event: completion });
  state = sessionEventStreamReducer(state, { type: "delta.received", delta: old });
  expect(state.activeDeltas).toEqual([next]);
  state = sessionEventStreamReducer(initialSessionEventStreamState, { type: "history.loaded", events: [completion] });
  state = sessionEventStreamReducer(state, { type: "deltas.loaded", deltas: [old, next] });
  expect(state.activeDeltas).toEqual([next]);
});
