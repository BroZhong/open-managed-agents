import { describe, it, expect } from "vitest";
import type { SessionEvent } from "@open-managed-agents/adapter-core";
import type {
  AssistantMessage,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { eventLogToAgentMessages } from "../src/event-log-to-messages.js";

/**
 * History reaches the adapter shaped as `{ type, ...data }` (the Host spreads
 * the stored event body onto the type). These helpers mirror that shape.
 */
function userMessage(text: string): SessionEvent {
  return {
    id: "sevt_u",
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "user.message",
    data: { content: [{ type: "text", text }] },
  } as unknown as SessionEvent;
}

function agentMessage(
  text: string,
  origin?: {
    provider?: string;
    api?: string;
    model?: string;
    stopReason?: string;
  },
): SessionEvent {
  return {
    id: "sevt_a",
    timestamp: "2026-01-01T00:00:01.000Z",
    type: "agent.message",
    content: [{ type: "text", text }],
    ...origin,
  } as unknown as SessionEvent;
}

function toolUse(
  toolUseId: string,
  name: string,
  input: Record<string, unknown>,
): SessionEvent {
  return {
    id: "sevt_tu",
    timestamp: "2026-01-01T00:00:02.000Z",
    type: "agent.tool_use",
    toolUseId,
    name,
    input,
  } as unknown as SessionEvent;
}

function toolResult(
  toolUseId: string,
  text: string,
  isError = false,
): SessionEvent {
  return {
    id: "sevt_tr",
    timestamp: "2026-01-01T00:00:03.000Z",
    type: "agent.tool_result",
    toolUseId,
    content: [{ type: "text", text }],
    isError,
  } as unknown as SessionEvent;
}

describe("eventLogToAgentMessages", () => {
  it("maps user.message → { role: 'user' }", () => {
    const messages = eventLogToAgentMessages([userMessage("hello")]);
    expect(messages).toHaveLength(1);
    const m = messages[0] as UserMessage;
    expect(m.role).toBe("user");
    expect(m.content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("maps agent.message → { role: 'assistant' } with a text block", () => {
    const messages = eventLogToAgentMessages([agentMessage("hi there")]);
    expect(messages).toHaveLength(1);
    const m = messages[0] as AssistantMessage;
    expect(m.role).toBe("assistant");
    expect(m.content).toEqual([{ type: "text", text: "hi there" }]);
  });

  it("aggregates agent.tool_use blocks INTO the turn's assistant message", () => {
    const messages = eventLogToAgentMessages([
      userMessage("list files"),
      agentMessage("Let me look."),
      toolUse("tc_1", "exec", { command: "ls" }),
    ]);

    // user, assistant(text + toolCall) — NOT a standalone tool-use message.
    expect(messages).toHaveLength(2);
    const assistant = messages[1] as AssistantMessage;
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toEqual([
      { type: "text", text: "Let me look." },
      { type: "toolCall", id: "tc_1", name: "exec", arguments: { command: "ls" } },
    ]);
  });

  it("maps agent.tool_result → { role: 'toolResult' } and closes the turn", () => {
    const messages = eventLogToAgentMessages([
      agentMessage("Running."),
      toolUse("tc_1", "exec", { command: "ls" }),
      toolResult("tc_1", "file1.ts\nfile2.ts"),
    ]);

    expect(messages).toHaveLength(2);
    const result = messages[1] as ToolResultMessage;
    expect(result.role).toBe("toolResult");
    expect(result.toolCallId).toBe("tc_1");
    expect(result.content).toEqual([
      { type: "text", text: "file1.ts\nfile2.ts" },
    ]);
    expect(result.isError).toBe(false);
  });

  it("preserves isError on tool results", () => {
    const messages = eventLogToAgentMessages([
      toolUse("tc_2", "exec", { command: "false" }),
      toolResult("tc_2", "boom", true),
    ]);
    const result = messages.find((m) => m.role === "toolResult") as ToolResultMessage;
    expect(result.isError).toBe(true);
  });

  it("pairs toolCall.id ↔ toolResult.toolCallId (round-trip key)", () => {
    const messages = eventLogToAgentMessages([
      agentMessage(""),
      toolUse("tc_pair", "exec", { command: "pwd" }),
      toolResult("tc_pair", "/home"),
    ]);
    const assistant = messages.find((m) => m.role === "assistant") as AssistantMessage;
    const toolCall = assistant.content.find(
      (c): c is ToolCall => c.type === "toolCall",
    );
    const result = messages.find((m) => m.role === "toolResult") as ToolResultMessage;
    expect(toolCall?.id).toBe(result.toolCallId);
    expect(toolCall?.id).toBe("tc_pair");
  });

  it("carries origin provider/api/model onto the assistant message", () => {
    const messages = eventLogToAgentMessages([
      agentMessage("hi", {
        provider: "anthropic",
        api: "anthropic-messages",
        model: "claude-sonnet-4-5",
      }),
    ]);
    const m = messages[0] as AssistantMessage;
    expect(m.provider).toBe("anthropic");
    expect(m.api).toBe("anthropic-messages");
    expect(m.model).toBe("claude-sonnet-4-5");
  });

  it("rebuilds a full multi-turn conversation with a tool call", () => {
    const messages = eventLogToAgentMessages([
      userMessage("how many files?"),
      agentMessage("Let me check.", { provider: "anthropic", model: "claude-sonnet-4-5" }),
      toolUse("tc_1", "exec", { command: "ls" }),
      toolResult("tc_1", "a.ts\nb.ts"),
      agentMessage("There are 2 files."),
      userMessage("thanks"),
    ]);

    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "user",
    ]);
    const firstAssistant = messages[1] as AssistantMessage;
    expect(firstAssistant.content).toEqual([
      { type: "text", text: "Let me check." },
      { type: "toolCall", id: "tc_1", name: "exec", arguments: { command: "ls" } },
    ]);
  });

  it("ignores lifecycle / span / thinking / streaming events", () => {
    const noise: SessionEvent[] = [
      { id: "1", timestamp: "t", type: "session.status_running" } as SessionEvent,
      { id: "2", timestamp: "t", type: "span.model_request_start", model: "x" } as SessionEvent,
      { id: "3", timestamp: "t", type: "agent.thinking", text: "hmm" } as SessionEvent,
      { id: "4", timestamp: "t", type: "agent.message_chunk", text: "partial" } as SessionEvent,
      agentMessage("final"),
    ];
    const messages = eventLogToAgentMessages(noise);
    expect(messages).toHaveLength(1);
    expect((messages[0] as AssistantMessage).content).toEqual([
      { type: "text", text: "final" },
    ]);
  });

  it("returns an empty array for empty history (first turn)", () => {
    expect(eventLogToAgentMessages([])).toEqual([]);
  });

  describe("stopReason (issue #111)", () => {
    it("carries a recorded aborted stopReason onto the rebuilt assistant message", () => {
      const messages = eventLogToAgentMessages([
        userMessage("write a poem"),
        agentMessage("Half a th", { stopReason: "aborted" }),
      ]);
      expect((messages[1] as AssistantMessage).stopReason).toBe("aborted");
    });

    it("treats an event with no stopReason as completed (backward compatible)", () => {
      const messages = eventLogToAgentMessages([
        userMessage("hi"),
        agentMessage("Hello!"),
      ]);
      expect((messages[1] as AssistantMessage).stopReason).toBe("stop");
    });

    it("falls back to stop for a value outside Pi's StopReason union", () => {
      const messages = eventLogToAgentMessages([
        userMessage("hi"),
        agentMessage("Hello!", { stopReason: "something-else" }),
      ]);
      expect((messages[1] as AssistantMessage).stopReason).toBe("stop");
    });

    it("keeps the aborted reason when the interrupted message also requested a tool", () => {
      const messages = eventLogToAgentMessages([
        userMessage("run it"),
        agentMessage("Let me check.", { stopReason: "aborted" }),
        toolUse("tc_1", "exec", { command: "ls" }),
      ]);
      const assistant = messages[1] as AssistantMessage;
      expect(assistant.stopReason).toBe("aborted");
      expect(assistant.content).toHaveLength(2);
    });

    it("drops the tool results belonging to a discarded assistant, leaving no orphan", () => {
      // Pi discards an aborted assistant whole — including its toolCalls. A
      // toolResult for one of those calls would then reach the provider with no
      // request in front of it, which the provider APIs reject. Since the
      // assistant is going, its results must go with it (issue #112).
      const messages = eventLogToAgentMessages([
        userMessage("run it"),
        agentMessage("Let me check.", { stopReason: "aborted" }),
        toolUse("tc_1", "exec", { command: "ls" }),
        toolResult("tc_1", "The previous tool execution was interrupted", true),
        userMessage("try again"),
      ]);

      expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
      expect((messages[1] as AssistantMessage).stopReason).toBe("aborted");
    });

    it("keeps tool results whose assistant survives", () => {
      const messages = eventLogToAgentMessages([
        userMessage("run it"),
        agentMessage("Let me check."),
        toolUse("tc_1", "exec", { command: "ls" }),
        toolResult("tc_1", "a.ts"),
      ]);

      expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult"]);
    });

    it("drops only the discarded assistant's results, not a later turn's", () => {
      const messages = eventLogToAgentMessages([
        agentMessage("Interrupted here.", { stopReason: "aborted" }),
        toolUse("tc_dropped", "exec", { command: "sleep 999" }),
        toolResult("tc_dropped", "interrupted", true),
        userMessage("again"),
        agentMessage("Working."),
        toolUse("tc_kept", "exec", { command: "ls" }),
        toolResult("tc_kept", "a.ts"),
      ]);

      const results = messages.filter(
        (m): m is ToolResultMessage => m.role === "toolResult",
      );
      expect(results.map((r) => r.toolCallId)).toEqual(["tc_kept"]);
    });
  });
});
