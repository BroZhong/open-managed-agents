import { describe, expect, it } from "vitest";
import type { SessionDelta, SessionEvent } from "@/lib/types";
import {
  processEventsToMessages,
  shouldShowTypingIndicator,
} from "@/lib/conversation-projection";

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
      {
        id: "assistant-turn_10:0",
        role: "assistant_streaming",
        text: "Working...",
      },
    ]);
    expect(result.messages[1]).not.toHaveProperty("seq");
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

  it("keeps partial output from an older block visible when a later block starts", () => {
    const result = processEventsToMessages(
      [userMessage],
      [
        delta("agent.message_stream_start", "1-0", {}),
        delta("agent.message_chunk", "1-1", { text: "I will inspect it." }),
        {
          ...delta("agent.tool_use_input_stream_start", "1-2", {
            toolUseId: "tool_1",
            name: "read",
          }),
          blockIndex: 1,
        },
        {
          ...delta("agent.tool_use_input_chunk", "1-3", {
            toolUseId: "tool_1",
            delta: '{"path":"/skills/storyboard/SKILL.md"}',
          }),
          blockIndex: 1,
        },
      ],
    );

    expect(result.messages).toMatchObject([
      { role: "user", text: "Explain" },
      { role: "assistant_streaming", text: "I will inspect it." },
      {
        role: "tool_use",
        name: "read",
        input: '{"path":"/skills/storyboard/SKILL.md"}',
        streaming: true,
      },
    ]);
  });

  it("keeps the same logical message id when a Delta block becomes durable", () => {
    const streaming = processEventsToMessages(
      [userMessage],
      [
        delta("agent.message_stream_start", "1-0", {}),
        delta("agent.message_chunk", "1-1", { text: "Stable" }),
      ],
    );
    const complete: SessionEvent = {
      seq: 11,
      type: "agent.message",
      data: {
        content: [{ type: "text", text: "Stable" }],
        turnId: "turn_10",
        blockIndex: 0,
      },
      ts: "2026-07-11T00:00:02.000Z",
    };
    const durable = processEventsToMessages([userMessage, complete]);

    expect(streaming.messages.at(-1)?.id).toBe("assistant-turn_10:0");
    expect(durable.messages.at(-1)?.id).toBe(streaming.messages.at(-1)?.id);
  });

  it("shows the typing indicator only before the current Turn has any response", () => {
    expect(
      shouldShowTypingIndicator(
        [{ role: "user", id: "user-10", text: "Explain", seq: 10 }],
        "running",
      ),
    ).toBe(true);
    expect(
      shouldShowTypingIndicator(
        [
          { role: "user", id: "user-10", text: "Explain", seq: 10 },
          { role: "assistant", id: "assistant-11", text: "Visible", seq: 11 },
        ],
        "running",
      ),
    ).toBe(false);
  });
});
