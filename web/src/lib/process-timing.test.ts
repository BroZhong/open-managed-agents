import { expect, it } from "vitest";
import { processEventsToMessages } from "./conversation-projection";
import { formatElapsedTime, processTimings } from "./process-timing";
import type { SessionDelta, SessionEvent } from "./types";

const start = Date.parse("2026-09-16T00:00:00Z");
const event = (seq: number, seconds: number, type: string, data: unknown = {}): SessionEvent => ({ seq, type, data, ts: new Date(start + seconds * 1000).toISOString() });
const text = (seq: number, seconds: number) => event(seq, seconds, "agent.message", { content: [{ type: "text", text: `Update ${seq}` }] });
function timings(events: SessionEvent[], deltas: SessionDelta[] = []) {
  return [...processTimings(processEventsToMessages(events, deltas).messages, events, deltas).values()].map(({ startedAt, endedAt }) => [ (startedAt - start) / 1000, (endedAt - start) / 1000 ]);
}

it("measures separate wall-time groups and includes overlapping tool results only once", () => {
  expect(timings([
    event(1, 0, "user.message", { content: [] }),
    event(2, 30, "session.status_running"),
    event(3, 35, "span.model_request_start"),
    event(4, 40, "agent.thinking", { text: "Think" }),
    event(5, 45, "agent.tool_use", { toolUseId: "a", name: "read" }),
    event(6, 45, "agent.tool_use", { toolUseId: "b", name: "read" }),
    event(7, 60, "agent.tool_result", { toolUseId: "a", content: "OK" }),
    event(8, 65, "agent.tool_result", { toolUseId: "b", content: "OK" }),
    text(9, 70),
    event(10, 75, "span.model_request_start"),
    event(11, 80, "agent.thinking", { text: "Think again" }),
    event(12, 85, "agent.tool_use", { toolUseId: "c", name: "read" }),
    event(13, 90, "agent.tool_result", { toolUseId: "c", content: "OK" }),
    text(14, 95),
  ])).toEqual([[30, 70], [75, 95]]);
});

it("freezes interrupted work and excludes idle time before the next Turn", () => {
  expect(timings([
    event(1, 0, "session.status_running"),
    event(2, 10, "agent.tool_use", { toolUseId: "a", name: "bash" }),
    event(3, 20, "session.turn_aborted"),
    event(4, 1000, "session.status_running"),
    text(5, 1010),
  ])).toEqual([[0, 20]]);
});

it("uses Delta timestamps during streaming and preserves the model start on completion", () => {
  const events = [event(1, 5, "span.model_request_start")];
  const delta: SessionDelta = { type: "agent.thinking_chunk", data: { text: "Reasoning" }, turnId: "turn", blockIndex: 0, ts: new Date(start + 10000).toISOString() };
  expect(timings(events, [delta])).toEqual([[5, 10]]);
  expect(timings([...events, event(2, 20, "agent.thinking", { text: "Reasoning", turnId: "turn", blockIndex: 0 }), text(3, 25)])).toEqual([[5, 25]]);
});

it("does not invent elapsed time when timestamps are missing", () => {
  expect(timings([{ seq: 1, type: "agent.tool_use", data: { toolUseId: "a" }, ts: "" }])).toEqual([]);
});

it.each([[0,"0s"], [59000,"59s"], [136000,"2m 16s"], [326000,"5m 26s"], [3661000,"1h 1m 1s"], [-1000,"0s"]])("formats %i ms as %s", (value, label) => {
  expect(formatElapsedTime(value)).toBe(label);
});
