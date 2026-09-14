import { describe, it, expect } from "vitest";
import type { SessionEvent } from "@open-managed-agents/adapter-core";
import { eventsToMessages } from "../src/session-file.js";
import { SdkEventTranslator } from "../src/translator.js";
import type { SdkMessage } from "../src/sdk-types.js";

/**
 * Test: reconstructing full message history from events alone.
 *
 * The canonical event stream must contain enough information to rebuild
 * the alternating assistant/user message array needed for session resumption.
 * In particular, tool_result events MUST be present between tool_use and
 * the next assistant message — without them, the conversation cannot be resumed.
 */

function translateAll(messages: SdkMessage[]): SessionEvent[] {
  const translator = new SdkEventTranslator("turn_test");
  const events: SessionEvent[] = [];
  for (const msg of messages) {
    events.push(...translator.processMessage(msg));
  }
  events.push(...translator.finalize());
  return events;
}

describe("eventsToMessages — message reconstruction from events", () => {
  describe("simple text-only turn", () => {
    it("reconstructs a single assistant message", () => {
      const sdkMessages: SdkMessage[] = [
        { type: "message_start", message: { id: "msg_001", model: "claude-sonnet-4-20250514" } },
        { type: "content_block_start", index: 0, content_block: { type: "text" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello world" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
        { type: "message_stop" },
      ];

      const events = translateAll(sdkMessages);
      const messages = eventsToMessages(events);

      expect(messages).toEqual([
        { role: "assistant", content: [{ type: "text", text: "Hello world" }] },
      ]);
    });
  });

  describe("tool-use turn with tool result", () => {
    const sdkMessages: SdkMessage[] = [
      // First span: model calls a tool
      { type: "message_start", message: { id: "msg_002", model: "claude-sonnet-4-20250514" } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_001", name: "Read" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"file_path":"/foo.ts"}' },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } },
      { type: "message_stop" },
      // Tool result
      { type: "tool_result", tool_use_id: "toolu_001", content: "export const x = 1;" },
      // Second span: model responds with text
      { type: "message_start", message: { id: "msg_003", model: "claude-sonnet-4-20250514" } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "The file exports x = 1." },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } },
      { type: "message_stop" },
    ];

    it("includes tool_result between tool_use and the next assistant message", () => {
      const events = translateAll(sdkMessages);
      const messages = eventsToMessages(events);

      expect(messages).toHaveLength(3);
      expect(messages[0]).toEqual({
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_001", name: "Read", input: { file_path: "/foo.ts" } },
        ],
      });
      expect(messages[1]).toEqual({
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_001", content: "export const x = 1;" },
        ],
      });
      expect(messages[2]).toEqual({
        role: "assistant",
        content: [{ type: "text", text: "The file exports x = 1." }],
      });
    });

    it("produces valid alternating roles for API re-submission", () => {
      const events = translateAll(sdkMessages);
      const messages = eventsToMessages(events);

      // Messages must alternate: assistant, user, assistant, ...
      for (let i = 1; i < messages.length; i++) {
        expect(messages[i]!.role).not.toBe(messages[i - 1]!.role);
      }
    });
  });

  describe("multiple tool calls in sequence", () => {
    const sdkMessages: SdkMessage[] = [
      // First model response: two tool uses
      { type: "message_start", message: { id: "msg_004", model: "claude-sonnet-4-20250514" } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_a", name: "Bash" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 10 } },
      { type: "message_stop" },
      // First tool result
      { type: "tool_result", tool_use_id: "toolu_a", content: "file1.ts\nfile2.ts" },
      // Second model request: another tool
      { type: "message_start", message: { id: "msg_005", model: "claude-sonnet-4-20250514" } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_b", name: "Read" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"file_path":"file1.ts"}' },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 10 } },
      { type: "message_stop" },
      // Second tool result
      { type: "tool_result", tool_use_id: "toolu_b", content: "console.log('hi')" },
      // Final text response
      { type: "message_start", message: { id: "msg_006", model: "claude-sonnet-4-20250514" } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ];

    it("reconstructs the full multi-step conversation", () => {
      const events = translateAll(sdkMessages);
      const messages = eventsToMessages(events);

      expect(messages).toHaveLength(5);
      expect(messages.map((m) => m.role)).toEqual([
        "assistant",
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
    });

    it("pairs each tool_use with its corresponding tool_result", () => {
      const events = translateAll(sdkMessages);
      const messages = eventsToMessages(events);

      // First tool_use → first tool_result
      const firstUse = messages[0]!.content[0] as any;
      const firstResult = messages[1]!.content[0] as any;
      expect(firstUse.type).toBe("tool_use");
      expect(firstUse.id).toBe("toolu_a");
      expect(firstResult.type).toBe("tool_result");
      expect(firstResult.tool_use_id).toBe("toolu_a");
      expect(firstResult.content).toBe("file1.ts\nfile2.ts");

      // Second tool_use → second tool_result
      const secondUse = messages[2]!.content[0] as any;
      const secondResult = messages[3]!.content[0] as any;
      expect(secondUse.type).toBe("tool_use");
      expect(secondUse.id).toBe("toolu_b");
      expect(secondResult.type).toBe("tool_result");
      expect(secondResult.tool_use_id).toBe("toolu_b");
      expect(secondResult.content).toBe("console.log('hi')");
    });
  });

  describe("MCP tool call", () => {
    const sdkMessages: SdkMessage[] = [
      { type: "message_start", message: { id: "msg_007", model: "claude-sonnet-4-20250514" } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_mcp_1", name: "mcp__github__list_prs" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"repo":"foo/bar"}' },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } },
      { type: "message_stop" },
      // MCP tool result
      { type: "tool_result", tool_use_id: "toolu_mcp_1", content: "PR #1, PR #2" },
      // Final text
      { type: "message_start", message: { id: "msg_008", model: "claude-sonnet-4-20250514" } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Found 2 PRs." } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ];

    it("reconstructs MCP tool calls correctly", () => {
      const events = translateAll(sdkMessages);
      const messages = eventsToMessages(events);

      expect(messages).toHaveLength(3);
      // MCP tool_use should include the full prefixed name
      const toolUse = messages[0]!.content[0] as any;
      expect(toolUse.type).toBe("tool_use");
      expect(toolUse.name).toBe("mcp__github__list_prs");
      expect(toolUse.id).toBe("toolu_mcp_1");

      // MCP tool_result
      const toolResult = messages[1]!.content[0] as any;
      expect(toolResult.type).toBe("tool_result");
      expect(toolResult.tool_use_id).toBe("toolu_mcp_1");
      expect(toolResult.content).toBe("PR #1, PR #2");
    });
  });

  describe("error tool result", () => {
    it("preserves isError flag in reconstruction", () => {
      const sdkMessages: SdkMessage[] = [
        { type: "message_start", message: { id: "msg_009", model: "claude-sonnet-4-20250514" } },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_err", name: "Bash" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"command":"exit 1"}' },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 8 } },
        { type: "message_stop" },
        { type: "tool_result", tool_use_id: "toolu_err", content: "command failed", is_error: true },
      ];

      const events = translateAll(sdkMessages);
      const messages = eventsToMessages(events);

      const toolResult = messages[1]!.content[0] as any;
      expect(toolResult.is_error).toBe(true);
      expect(toolResult.content).toBe("command failed");
    });
  });

  describe("thinking + text + tool in one turn", () => {
    it("reconstructs thinking, text, and tool blocks in order", () => {
      const sdkMessages: SdkMessage[] = [
        { type: "message_start", message: { id: "msg_010", model: "claude-sonnet-4-20250514" } },
        // Thinking block
        { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "I need to read the file" } },
        { type: "content_block_stop", index: 0 },
        // Text block
        { type: "content_block_start", index: 1, content_block: { type: "text" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Let me check." } },
        { type: "content_block_stop", index: 1 },
        // Tool block
        {
          type: "content_block_start",
          index: 2,
          content_block: { type: "tool_use", id: "toolu_010", name: "Read" },
        },
        {
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: '{"file_path":"x.ts"}' },
        },
        { type: "content_block_stop", index: 2 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } },
        { type: "message_stop" },
        // Tool result
        { type: "tool_result", tool_use_id: "toolu_010", content: "const x = 42;" },
      ];

      const events = translateAll(sdkMessages);
      const messages = eventsToMessages(events);

      // thinking, text, tool_use are each separate messages (by current design)
      // then tool_result as user message
      expect(messages.length).toBeGreaterThanOrEqual(4);

      const types = messages.map((m) => ({
        role: m.role,
        contentType: m.content[0]!.type,
      }));
      expect(types).toContainEqual({ role: "assistant", contentType: "thinking" });
      expect(types).toContainEqual({ role: "assistant", contentType: "text" });
      expect(types).toContainEqual({ role: "assistant", contentType: "tool_use" });
      expect(types).toContainEqual({ role: "user", contentType: "tool_result" });
    });
  });

  describe("filtering non-canonical events", () => {
    it("ignores streaming, span, and lifecycle events", () => {
      const events: SessionEvent[] = [
        { id: "e1", timestamp: "t1", type: "session.status_running" },
        { id: "e2", timestamp: "t2", type: "span.model_request_start", model: "claude-sonnet-4-20250514" },
        { id: "e3", timestamp: "t3", type: "span.model_first_token" },
        { id: "e4", timestamp: "t4", type: "agent.message_stream_start" },
        { id: "e5", timestamp: "t5", type: "agent.message_chunk", text: "Hi" },
        { id: "e6", timestamp: "t6", type: "agent.message_stream_end" },
        { id: "e7", timestamp: "t7", type: "agent.message", content: [{ type: "text", text: "Hi" }] },
        {
          id: "e8",
          timestamp: "t8",
          type: "span.model_request_end",
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        },
        { id: "e9", timestamp: "t9", type: "session.status_idle" },
      ];

      const messages = eventsToMessages(events);
      expect(messages).toEqual([
        { role: "assistant", content: [{ type: "text", text: "Hi" }] },
      ]);
    });
  });

  describe("round-trip completeness", () => {
    it("every tool_use event has a matching tool_result in the reconstructed messages", () => {
      const sdkMessages: SdkMessage[] = [
        { type: "message_start", message: { id: "msg_rt1", model: "claude-sonnet-4-20250514" } },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_rt_1", name: "Glob" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"pattern":"**/*.ts"}' },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 10 } },
        { type: "message_stop" },
        { type: "tool_result", tool_use_id: "toolu_rt_1", content: "a.ts\nb.ts" },
        { type: "message_start", message: { id: "msg_rt2", model: "claude-sonnet-4-20250514" } },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_rt_2", name: "Read" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"file_path":"a.ts"}' },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 10 } },
        { type: "message_stop" },
        { type: "tool_result", tool_use_id: "toolu_rt_2", content: "export const a = 1;" },
        { type: "message_start", message: { id: "msg_rt3", model: "claude-sonnet-4-20250514" } },
        { type: "content_block_start", index: 0, content_block: { type: "text" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Found 2 files." } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8 } },
        { type: "message_stop" },
      ];

      const events = translateAll(sdkMessages);
      const messages = eventsToMessages(events);

      // Collect all tool_use IDs from assistant messages
      const toolUseIds = messages
        .filter((m) => m.role === "assistant")
        .flatMap((m) => m.content)
        .filter((c) => c.type === "tool_use")
        .map((c) => (c as any).id);

      // Collect all tool_result tool_use_ids from user messages
      const toolResultIds = messages
        .filter((m) => m.role === "user")
        .flatMap((m) => m.content)
        .filter((c) => c.type === "tool_result")
        .map((c) => (c as any).tool_use_id);

      // Every tool_use must have a matching tool_result
      expect(toolUseIds).toEqual(["toolu_rt_1", "toolu_rt_2"]);
      expect(toolResultIds).toEqual(["toolu_rt_1", "toolu_rt_2"]);

      // Verify 1:1 mapping
      for (const id of toolUseIds) {
        expect(toolResultIds).toContain(id);
      }
    });
  });
});
