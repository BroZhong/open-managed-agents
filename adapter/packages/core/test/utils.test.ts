import { describe, it, expect } from "vitest";
import {
  generateEventId,
  generateTimestamp,
  isCanonicalEvent,
  isStreamEvent,
  isLifecycleEvent,
  isSpanEvent,
  buildPromptWithHistory,
} from "../src/utils.js";
import type { SessionEvent } from "../src/types.js";

describe("generateEventId", () => {
  it("produces a string with sevt_ prefix", () => {
    const id = generateEventId();
    expect(id).toMatch(/^sevt_/);
  });

  it("produces unique IDs on successive calls", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateEventId()));
    expect(ids.size).toBe(100);
  });

  it("has reasonable length (prefix + at least 10 chars)", () => {
    const id = generateEventId();
    expect(id.length).toBeGreaterThanOrEqual(15);
  });
});

describe("generateTimestamp", () => {
  it("produces a valid ISO 8601 string", () => {
    const ts = generateTimestamp();
    const parsed = new Date(ts);
    expect(parsed.toISOString()).toBe(ts);
  });

  it("produces a timestamp close to now", () => {
    const before = Date.now();
    const ts = generateTimestamp();
    const after = Date.now();
    const tsMs = new Date(ts).getTime();
    expect(tsMs).toBeGreaterThanOrEqual(before);
    expect(tsMs).toBeLessThanOrEqual(after);
  });
});

describe("isLifecycleEvent", () => {
  it("returns true for session.status_running", () => {
    const event: SessionEvent = {
      id: "sevt_abc",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "session.status_running",
    };
    expect(isLifecycleEvent(event)).toBe(true);
  });

  it("returns true for session.status_idle", () => {
    const event: SessionEvent = {
      id: "sevt_abc",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "session.status_idle",
    };
    expect(isLifecycleEvent(event)).toBe(true);
  });

  it("returns true for session.error", () => {
    const event: SessionEvent = {
      id: "sevt_abc",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "session.error",
      error: { message: "something went wrong", code: "UNKNOWN" },
    };
    expect(isLifecycleEvent(event)).toBe(true);
  });

  it("returns false for non-lifecycle events", () => {
    const event: SessionEvent = {
      id: "sevt_abc",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "agent.message",
      content: [{ type: "text", text: "hello" }],
    };
    expect(isLifecycleEvent(event)).toBe(false);
  });
});

describe("isSpanEvent", () => {
  it("returns true for span.model_request_start", () => {
    const event: SessionEvent = {
      id: "sevt_abc",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "span.model_request_start",
      model: "claude-sonnet-4-20250514",
    };
    expect(isSpanEvent(event)).toBe(true);
  });

  it("returns true for span.model_first_token", () => {
    const event: SessionEvent = {
      id: "sevt_abc",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "span.model_first_token",
    };
    expect(isSpanEvent(event)).toBe(true);
  });

  it("returns true for span.model_request_end", () => {
    const event: SessionEvent = {
      id: "sevt_abc",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "span.model_request_end",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    };
    expect(isSpanEvent(event)).toBe(true);
  });

  it("returns false for non-span events", () => {
    const event: SessionEvent = {
      id: "sevt_abc",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "session.status_running",
    };
    expect(isSpanEvent(event)).toBe(false);
  });
});

describe("isCanonicalEvent", () => {
  it("returns true for agent.message", () => {
    const event: SessionEvent = {
      id: "sevt_abc",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "agent.message",
      content: [{ type: "text", text: "hello" }],
    };
    expect(isCanonicalEvent(event)).toBe(true);
  });

  it("returns true for agent.thinking", () => {
    const event: SessionEvent = {
      id: "sevt_abc",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "agent.thinking",
      text: "thinking...",
    };
    expect(isCanonicalEvent(event)).toBe(true);
  });

  it("returns true for agent.tool_use", () => {
    const event: SessionEvent = {
      id: "sevt_abc",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "agent.tool_use",
      toolUseId: "tu_123",
      name: "read_file",
      input: { path: "/foo" },
    };
    expect(isCanonicalEvent(event)).toBe(true);
  });

  it("returns true for agent.tool_result", () => {
    const event: SessionEvent = {
      id: "sevt_abc",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "agent.tool_result",
      toolUseId: "tu_123",
      content: [{ type: "text", text: "result" }],
    };
    expect(isCanonicalEvent(event)).toBe(true);
  });

  it("returns true for agent.mcp_tool_use", () => {
    const event: SessionEvent = {
      id: "sevt_abc",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "agent.mcp_tool_use",
      toolUseId: "tu_123",
      serverName: "my-server",
      name: "search",
      input: { query: "foo" },
    };
    expect(isCanonicalEvent(event)).toBe(true);
  });

  it("returns true for agent.mcp_tool_result", () => {
    const event: SessionEvent = {
      id: "sevt_abc",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "agent.mcp_tool_result",
      toolUseId: "tu_123",
      serverName: "my-server",
      content: [{ type: "text", text: "result" }],
    };
    expect(isCanonicalEvent(event)).toBe(true);
  });

  it("returns false for stream events", () => {
    const event: SessionEvent = {
      id: "sevt_abc",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "agent.message_stream_start",
    };
    expect(isCanonicalEvent(event)).toBe(false);
  });

  it("returns false for lifecycle events", () => {
    const event: SessionEvent = {
      id: "sevt_abc",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "session.status_running",
    };
    expect(isCanonicalEvent(event)).toBe(false);
  });
});

describe("isStreamEvent", () => {
  it("returns true for agent.message_stream_start", () => {
    const event: SessionEvent = {
      id: "sevt_abc",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "agent.message_stream_start",
    };
    expect(isStreamEvent(event)).toBe(true);
  });

  it("returns true for agent.message_chunk", () => {
    const event: SessionEvent = {
      id: "sevt_abc",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "agent.message_chunk",
      text: "hello",
    };
    expect(isStreamEvent(event)).toBe(true);
  });

  it("returns true for agent.message_stream_end", () => {
    const event: SessionEvent = {
      id: "sevt_abc",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "agent.message_stream_end",
    };
    expect(isStreamEvent(event)).toBe(true);
  });

  it("returns true for agent.thinking_stream_start", () => {
    const event: SessionEvent = {
      id: "sevt_abc",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "agent.thinking_stream_start",
    };
    expect(isStreamEvent(event)).toBe(true);
  });

  it("returns true for agent.thinking_chunk", () => {
    const event: SessionEvent = {
      id: "sevt_abc",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "agent.thinking_chunk",
      text: "hmm",
    };
    expect(isStreamEvent(event)).toBe(true);
  });

  it("returns true for agent.thinking_stream_end", () => {
    const event: SessionEvent = {
      id: "sevt_abc",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "agent.thinking_stream_end",
    };
    expect(isStreamEvent(event)).toBe(true);
  });

  it("returns true for agent.tool_use_input_stream_start", () => {
    const event: SessionEvent = {
      id: "sevt_abc",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "agent.tool_use_input_stream_start",
      toolUseId: "tu_123",
      name: "read_file",
    };
    expect(isStreamEvent(event)).toBe(true);
  });

  it("returns true for agent.tool_use_input_chunk", () => {
    const event: SessionEvent = {
      id: "sevt_abc",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "agent.tool_use_input_chunk",
      toolUseId: "tu_123",
      delta: '{"path":',
    };
    expect(isStreamEvent(event)).toBe(true);
  });

  it("returns true for agent.tool_use_input_stream_end", () => {
    const event: SessionEvent = {
      id: "sevt_abc",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "agent.tool_use_input_stream_end",
      toolUseId: "tu_123",
    };
    expect(isStreamEvent(event)).toBe(true);
  });

  it("returns false for canonical events", () => {
    const event: SessionEvent = {
      id: "sevt_abc",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "agent.message",
      content: [{ type: "text", text: "hello" }],
    };
    expect(isStreamEvent(event)).toBe(false);
  });

  it("returns false for lifecycle events", () => {
    const event: SessionEvent = {
      id: "sevt_abc",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "session.status_running",
    };
    expect(isStreamEvent(event)).toBe(false);
  });
});

describe("buildPromptWithHistory", () => {
  it("returns the prompt unchanged when history is empty", () => {
    expect(buildPromptWithHistory("hello", [])).toBe("hello");
  });

  it("formats prior user and assistant messages", () => {
    const prompt = buildPromptWithHistory("What was it?", [
      {
        id: "sevt_user",
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "user.message",
        data: { content: [{ type: "text", text: "Remember CODE-1" }] },
      } as unknown as SessionEvent,
      {
        id: "sevt_assistant",
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "agent.message",
        content: [{ type: "text", text: "stored CODE-1" }],
      },
    ]);

    expect(prompt).toContain("<conversation_history>");
    expect(prompt).toContain("User: Remember CODE-1");
    expect(prompt).toContain("Assistant: stored CODE-1");
    expect(prompt).toContain("User: What was it?");
  });
});
