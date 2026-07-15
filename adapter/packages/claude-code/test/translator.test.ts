import { describe, it, expect } from "vitest";
import type { SessionEvent } from "@open-managed-agents/adapter-core";
import { SdkEventTranslator } from "../src/translator.js";
import type { SdkMessage } from "../src/sdk-types.js";

describe("SdkEventTranslator", () => {
  const turnId = "turn_test123";

  function processAll(
    messages: SdkMessage[],
    options?: { finalize?: boolean }
  ): SessionEvent[] {
    const translator = new SdkEventTranslator(turnId);
    const events: SessionEvent[] = [];
    for (const msg of messages) {
      events.push(...translator.processMessage(msg));
    }
    if (options?.finalize !== false) {
      events.push(...translator.finalize());
    }
    return events;
  }

  describe("text-only turn", () => {
    const messages: SdkMessage[] = [
      {
        type: "message_start",
        message: {
          id: "msg_001",
          model: "claude-sonnet-4-20250514",
          usage: {
            input_tokens: 60,
            cache_read_input_tokens: 30,
            cache_creation_input_tokens: 10,
          },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } },
      { type: "message_stop" },
    ];

    it("emits span.model_request_start on message_start", () => {
      const events = processAll(messages);
      const startEvent = events.find((e) => e.type === "span.model_request_start");
      expect(startEvent).toBeDefined();
      expect(startEvent!.type).toBe("span.model_request_start");
      expect((startEvent as any).model).toBe("claude-sonnet-4-20250514");
    });

    it("emits span.model_first_token on first content_block_delta", () => {
      const events = processAll(messages);
      const types = events.map((e) => e.type);
      const firstTokenIdx = types.indexOf("span.model_first_token");
      const startIdx = types.indexOf("span.model_request_start");
      expect(firstTokenIdx).toBeGreaterThan(startIdx);
      // Only one first_token event
      expect(types.filter((t) => t === "span.model_first_token")).toHaveLength(1);
    });

    it("emits message_stream_start, chunks, message_stream_end, and canonical message", () => {
      const events = processAll(messages);
      const types = events.map((e) => e.type);
      expect(types).toContain("agent.message_stream_start");
      expect(types).toContain("agent.message_chunk");
      expect(types).toContain("agent.message_stream_end");
      expect(types).toContain("agent.message");
    });

    it("accumulates text correctly in canonical message", () => {
      const events = processAll(messages);
      const messageEvent = events.find((e) => e.type === "agent.message") as any;
      expect(messageEvent).toBeDefined();
      expect(messageEvent.content).toEqual([{ type: "text", text: "Hello world" }]);
    });

    it("emits message_chunk with correct delta text", () => {
      const events = processAll(messages);
      const chunks = events.filter((e) => e.type === "agent.message_chunk") as any[];
      expect(chunks).toHaveLength(2);
      expect(chunks[0].text).toBe("Hello");
      expect(chunks[1].text).toBe(" world");
    });

    it("emits span.model_request_end with usage on message_delta", () => {
      const events = processAll(messages);
      const endEvent = events.find((e) => e.type === "span.model_request_end") as any;
      expect(endEvent).toBeDefined();
      expect(endEvent.usage).toEqual({
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 30,
        cacheWriteTokens: 10,
      });
    });

    it("emits events in correct order", () => {
      const events = processAll(messages);
      const types = events.map((e) => e.type);
      expect(types).toEqual([
        "span.model_request_start",
        "agent.message_stream_start",
        "span.model_first_token",
        "agent.message_chunk",
        "agent.message_chunk",
        "agent.message_stream_end",
        "agent.message",
        "span.model_request_end",
      ]);
    });
  });

  describe("tool-use turn", () => {
    const messages: SdkMessage[] = [
      { type: "message_start", message: { id: "msg_002", model: "claude-sonnet-4-20250514" } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_001", name: "read_file" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"path":' },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '"/foo.ts"}' },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } },
      { type: "message_stop" },
    ];

    it("emits tool_use_input_stream_start with tool info", () => {
      const events = processAll(messages);
      const startEvent = events.find(
        (e) => e.type === "agent.tool_use_input_stream_start"
      ) as any;
      expect(startEvent).toBeDefined();
      expect(startEvent.toolUseId).toBe("toolu_001");
      expect(startEvent.name).toBe("read_file");
    });

    it("emits tool_use_input_chunk events", () => {
      const events = processAll(messages);
      const chunks = events.filter(
        (e) => e.type === "agent.tool_use_input_chunk"
      ) as any[];
      expect(chunks).toHaveLength(2);
      expect(chunks[0].toolUseId).toBe("toolu_001");
      expect(chunks[0].delta).toBe('{"path":');
      expect(chunks[1].delta).toBe('"/foo.ts"}');
    });

    it("emits canonical agent.tool_use with accumulated input", () => {
      const events = processAll(messages);
      const toolUseEvent = events.find((e) => e.type === "agent.tool_use") as any;
      expect(toolUseEvent).toBeDefined();
      expect(toolUseEvent.toolUseId).toBe("toolu_001");
      expect(toolUseEvent.name).toBe("read_file");
      expect(toolUseEvent.input).toEqual({ path: "/foo.ts" });
    });

    it("emits events in correct order", () => {
      const events = processAll(messages);
      const types = events.map((e) => e.type);
      expect(types).toEqual([
        "span.model_request_start",
        "agent.tool_use_input_stream_start",
        "span.model_first_token",
        "agent.tool_use_input_chunk",
        "agent.tool_use_input_chunk",
        "agent.tool_use_input_stream_end",
        "agent.tool_use",
        "span.model_request_end",
      ]);
    });
  });

  describe("tool_result message", () => {
    it("emits agent.tool_result with content and toolUseId", () => {
      const messages: SdkMessage[] = [
        {
          type: "tool_result",
          tool_use_id: "toolu_001",
          content: "file contents here",
          is_error: false,
        },
      ];
      const events = processAll(messages);
      const resultEvent = events.find((e) => e.type === "agent.tool_result") as any;
      expect(resultEvent).toBeDefined();
      expect(resultEvent.toolUseId).toBe("toolu_001");
      expect(resultEvent.content).toEqual([{ type: "text", text: "file contents here" }]);
      expect(resultEvent.isError).toBe(false);
    });

    it("emits agent.tool_result with isError when is_error is true", () => {
      const messages: SdkMessage[] = [
        {
          type: "tool_result",
          tool_use_id: "toolu_002",
          content: "command failed",
          is_error: true,
        },
      ];
      const events = processAll(messages);
      const resultEvent = events.find((e) => e.type === "agent.tool_result") as any;
      expect(resultEvent).toBeDefined();
      expect(resultEvent.isError).toBe(true);
    });
  });

  describe("thinking turn", () => {
    const messages: SdkMessage[] = [
      { type: "message_start", message: { id: "msg_003", model: "claude-sonnet-4-20250514" } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me think" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: " about this" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Here is my answer" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 30 } },
      { type: "message_stop" },
    ];

    it("emits thinking stream events", () => {
      const events = processAll(messages);
      const types = events.map((e) => e.type);
      expect(types).toContain("agent.thinking_stream_start");
      expect(types).toContain("agent.thinking_chunk");
      expect(types).toContain("agent.thinking_stream_end");
    });

    it("emits canonical thinking event with accumulated text", () => {
      const events = processAll(messages);
      const thinkingEvent = events.find((e) => e.type === "agent.thinking") as any;
      expect(thinkingEvent).toBeDefined();
      expect(thinkingEvent.text).toBe("Let me think about this");
    });

    it("emits thinking_chunk with correct delta text", () => {
      const events = processAll(messages);
      const chunks = events.filter((e) => e.type === "agent.thinking_chunk") as any[];
      expect(chunks).toHaveLength(2);
      expect(chunks[0].text).toBe("Let me think");
      expect(chunks[1].text).toBe(" about this");
    });

    it("emits events in correct order (thinking then text)", () => {
      const events = processAll(messages);
      const types = events.map((e) => e.type);
      expect(types).toEqual([
        "span.model_request_start",
        "agent.thinking_stream_start",
        "span.model_first_token",
        "agent.thinking_chunk",
        "agent.thinking_chunk",
        "agent.thinking_stream_end",
        "agent.thinking",
        "agent.message_stream_start",
        "agent.message_chunk",
        "agent.message_stream_end",
        "agent.message",
        "span.model_request_end",
      ]);
    });
  });

  describe("MCP tool", () => {
    const messages: SdkMessage[] = [
      { type: "message_start", message: { id: "msg_004", model: "claude-sonnet-4-20250514" } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_mcp_001", name: "mcp__myserver__search" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"query":"test"}' },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 15 } },
      { type: "message_stop" },
    ];

    it("emits agent.mcp_tool_use instead of agent.tool_use for MCP tools", () => {
      const events = processAll(messages);
      const mcpEvent = events.find((e) => e.type === "agent.mcp_tool_use") as any;
      expect(mcpEvent).toBeDefined();
      expect(mcpEvent.toolUseId).toBe("toolu_mcp_001");
      expect(mcpEvent.name).toBe("mcp__myserver__search");
      expect(mcpEvent.serverName).toBe("myserver");
      expect(mcpEvent.input).toEqual({ query: "test" });
      // Should NOT emit agent.tool_use
      expect(events.find((e) => e.type === "agent.tool_use")).toBeUndefined();
    });

    it("emits agent.mcp_tool_result for MCP tool results", () => {
      const resultMessages: SdkMessage[] = [
        // First register the tool use so translator knows it's MCP
        { type: "message_start", message: { id: "msg_005", model: "claude-sonnet-4-20250514" } },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_mcp_002", name: "mcp__github__list_repos" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{}' },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
        { type: "message_stop" },
        // Now the tool result
        { type: "tool_result", tool_use_id: "toolu_mcp_002", content: "repo1, repo2" },
      ];
      const events = processAll(resultMessages);
      const mcpResult = events.find((e) => e.type === "agent.mcp_tool_result") as any;
      expect(mcpResult).toBeDefined();
      expect(mcpResult.toolUseId).toBe("toolu_mcp_002");
      expect(mcpResult.serverName).toBe("github");
      expect(mcpResult.content).toEqual([{ type: "text", text: "repo1, repo2" }]);
      // Should NOT emit agent.tool_result
      expect(events.find((e) => e.type === "agent.tool_result")).toBeUndefined();
    });
  });

  describe("usage tracking", () => {
    it("includes output token count in span.model_request_end", () => {
      const messages: SdkMessage[] = [
        { type: "message_start", message: { id: "msg_006", model: "claude-sonnet-4-20250514" } },
        { type: "content_block_start", index: 0, content_block: { type: "text" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } },
        { type: "message_stop" },
      ];
      const events = processAll(messages);
      const endEvent = events.find((e) => e.type === "span.model_request_end") as any;
      expect(endEvent.usage.outputTokens).toBe(42);
    });
  });

  describe("unique IDs", () => {
    it("every emitted event has a unique id", () => {
      const messages: SdkMessage[] = [
        { type: "message_start", message: { id: "msg_007", model: "claude-sonnet-4-20250514" } },
        { type: "content_block_start", index: 0, content_block: { type: "text" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "A" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "B" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
        { type: "message_stop" },
      ];
      const events = processAll(messages);
      const ids = events.map((e) => e.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it("all event IDs have the sevt_ prefix", () => {
      const messages: SdkMessage[] = [
        { type: "message_start", message: { id: "msg_008", model: "claude-sonnet-4-20250514" } },
        { type: "content_block_start", index: 0, content_block: { type: "text" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ];
      const events = processAll(messages);
      for (const event of events) {
        expect(event.id).toMatch(/^sevt_/);
      }
    });
  });

  describe("multi-span turn (tool use then continuation)", () => {
    const messages: SdkMessage[] = [
      // First span: tool use
      { type: "message_start", message: { id: "msg_009", model: "claude-sonnet-4-20250514" } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_010", name: "bash" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"cmd":"ls"}' },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 8 } },
      { type: "message_stop" },
      // Tool result
      { type: "tool_result", tool_use_id: "toolu_010", content: "file1.ts\nfile2.ts" },
      // Second span: text response
      { type: "message_start", message: { id: "msg_010", model: "claude-sonnet-4-20250514" } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Found 2 files" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } },
      { type: "message_stop" },
    ];

    it("emits two span pairs", () => {
      const events = processAll(messages);
      const starts = events.filter((e) => e.type === "span.model_request_start");
      const ends = events.filter((e) => e.type === "span.model_request_end");
      expect(starts).toHaveLength(2);
      expect(ends).toHaveLength(2);
    });

    it("emits first_token for each span", () => {
      const events = processAll(messages);
      const firstTokens = events.filter((e) => e.type === "span.model_first_token");
      expect(firstTokens).toHaveLength(2);
    });

    it("emits tool_result between spans", () => {
      const events = processAll(messages);
      const types = events.map((e) => e.type);
      const firstEnd = types.indexOf("span.model_request_end");
      const toolResult = types.indexOf("agent.tool_result");
      const secondStart = types.lastIndexOf("span.model_request_start");
      expect(toolResult).toBeGreaterThan(firstEnd);
      expect(toolResult).toBeLessThan(secondStart);
    });
  });

  describe("edge cases", () => {
    it("handles empty text block", () => {
      const messages: SdkMessage[] = [
        { type: "message_start", message: { id: "msg_011", model: "claude-sonnet-4-20250514" } },
        { type: "content_block_start", index: 0, content_block: { type: "text" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } },
        { type: "message_stop" },
      ];
      const events = processAll(messages);
      const messageEvent = events.find((e) => e.type === "agent.message") as any;
      expect(messageEvent).toBeDefined();
      expect(messageEvent.content).toEqual([{ type: "text", text: "" }]);
    });

    it("handles tool_use with empty JSON input", () => {
      const messages: SdkMessage[] = [
        { type: "message_start", message: { id: "msg_012", model: "claude-sonnet-4-20250514" } },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_012", name: "get_status" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "{}" },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
        { type: "message_stop" },
      ];
      const events = processAll(messages);
      const toolUseEvent = events.find((e) => e.type === "agent.tool_use") as any;
      expect(toolUseEvent.input).toEqual({});
    });

    it("handles tool_use with no delta messages (empty input)", () => {
      const messages: SdkMessage[] = [
        { type: "message_start", message: { id: "msg_013", model: "claude-sonnet-4-20250514" } },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_013", name: "noop" },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } },
        { type: "message_stop" },
      ];
      const events = processAll(messages);
      const toolUseEvent = events.find((e) => e.type === "agent.tool_use") as any;
      expect(toolUseEvent).toBeDefined();
      expect(toolUseEvent.input).toEqual({});
    });
  });
});
