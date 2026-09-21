import { expect, it } from "vitest";
import { presentEvent } from "../../../server/packages/store/src/event-presentation";
import { processEventsToMessages } from "./conversation-projection";
import { initialSessionEventStreamState, sessionEventStreamReducer } from "./session-event-stream";
import type { SessionEvent } from "./types";

const ts = "2026-09-21T00:00:00Z";
const native: SessionEvent[] = [
  { seq: 4, type: "agent.context_entry", ts, data: { id: "native1", turnId: "t1", timestamp: ts,
    entry: { id: "e1", type: "message", message: { role: "assistant", content: [
      { type: "thinking", thinking: "plan" }, { type: "text", text: "Reading file" }, { type: "toolCall", id: "call1", name: "read", arguments: { path: "image.png" } },
    ] } }, presentation: { version: 1, blocks: [{ type: "agent.thinking", index: 0, blockIndex: 0 }, { type: "agent.message", index: 1, blockIndex: 1 }, { type: "agent.tool_use", index: 2, blockIndex: 2 }] } } },
  { seq: 6, type: "agent.context_entry", ts, data: { id: "native2", turnId: "t1", timestamp: ts,
    entry: { id: "e2", type: "message", message: { role: "toolResult", toolCallId: "call1", isError: false, content: [{ type: "text", text: "image result" }] } },
    presentation: { version: 1, blocks: [{ type: "agent.tool_result" }] } } },
];
const legacy: SessionEvent[] = [
  { seq: 1, type: "agent.thinking", ts, data: { turnId: "t1", blockIndex: 0, text: "plan" } },
  { seq: 2, type: "agent.message", ts, data: { turnId: "t1", blockIndex: 1, content: [{ type: "text", text: "Reading file" }] } },
  { seq: 3, type: "agent.tool_use", ts, data: { turnId: "t1", blockIndex: 2, toolUseId: "call1", name: "read", input: { path: "image.png" } } },
  { seq: 5, type: "agent.tool_result", ts, data: { turnId: "t1", toolUseId: "call1", isError: false, content: [{ type: "text", text: "image result" }] } },
];

it("produces identical existing conversation messages from native projections and legacy display events", () => {
  expect(processEventsToMessages(native.flatMap(event => presentEvent(event)))).toEqual(processEventsToMessages(legacy));
});

it("replaces existing live deltas and deduplicates replay without changing the frontend reducer", () => {
  let state = sessionEventStreamReducer(initialSessionEventStreamState, { type: "delta.received", delta: {
    type: "agent.message_chunk", ts, turnId: "t1", blockIndex: 1, deltaId: "1-0", data: { text: "Reading" },
  } });
  const projected = native.flatMap(event => presentEvent(event));
  for (const event of projected) state = sessionEventStreamReducer(state, { type: "event.received", event });
  state = sessionEventStreamReducer(state, { type: "history.loaded", events: projected });
  expect(state.activeDeltas).toEqual([]);
  expect(state.events).toHaveLength(6);
  expect(processEventsToMessages(state.events, state.activeDeltas)).toEqual(processEventsToMessages(legacy));
});
