import { describe, expect, it } from "vitest";
import type { SessionDelta, SessionEvent } from "@/lib/types";
import { processEventsToMessages } from "@/lib/conversation-projection";

const userMessage: SessionEvent = {
  seq: 10,
  type: "user.message",
  data: { content: [{ type: "text", text: "Explain" }] },
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

describe("Conversation Delta projection", () => {
  it("renders active message Deltas after durable history", () => {
    const result = processEventsToMessages(
      [userMessage],
      [
        delta("agent.message_stream_start", "1-0", {}),
        delta("agent.message_chunk", "1-1", { text: "Working" }),
        delta("agent.message_chunk", "1-2", { text: "..." }),
      ],
    );

    expect(result.isStreaming).toBe(true);
    expect(result.messages).toMatchObject([
      { role: "user", text: "Explain", seq: 10 },
      { role: "assistant_streaming", text: "Working...", seq: -1 },
    ]);
  });

  it("uses the protocol's delta field for streamed tool input", () => {
    const result = processEventsToMessages(
      [userMessage],
      [
        delta("agent.tool_use_input_stream_start", "1-0", {
          toolUseId: "tool_1",
          name: "read",
        }),
        delta("agent.tool_use_input_chunk", "1-1", {
          toolUseId: "tool_1",
          delta: '{"path":',
        }),
      ],
    );

    expect(result.messages.at(-1)).toMatchObject({
      role: "tool_use",
      toolUseId: "tool_1",
      input: '{"path":',
      streaming: true,
    });
    expect(result.isStreaming).toBe(true);
  });
});
