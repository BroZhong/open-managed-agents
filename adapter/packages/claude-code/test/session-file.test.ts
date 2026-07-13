import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionEvent } from "@open-managed-agents/adapter-core";
import { eventsToSessionFile } from "../src/session-file.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "claude-code-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("eventsToSessionFile", () => {
  it("empty history produces valid minimal session file (empty array)", async () => {
    const path = await eventsToSessionFile([], "sess-001", workDir);
    const content = JSON.parse(await readFile(path, "utf-8"));
    expect(content).toEqual([]);
  });

  it("writes session file to correct path {workDir}/{sessionId}/session.json", async () => {
    const path = await eventsToSessionFile([], "sess-002", workDir);
    expect(path).toBe(join(workDir, "sess-002", "session.json"));
    expect(existsSync(path)).toBe(true);
  });

  it("creates directory if missing", async () => {
    const sessionId = "new-session-dir";
    const expectedDir = join(workDir, sessionId);
    expect(existsSync(expectedDir)).toBe(false);

    await eventsToSessionFile([], sessionId, workDir);
    expect(existsSync(expectedDir)).toBe(true);
  });

  it("agent.message produces correct assistant message in session file", async () => {
    const events: SessionEvent[] = [
      {
        id: "sevt_1",
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "agent.message",
        content: [{ type: "text", text: "Hello, world!" }],
      },
    ];

    const path = await eventsToSessionFile(events, "sess-msg", workDir);
    const content = JSON.parse(await readFile(path, "utf-8"));

    expect(content).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "Hello, world!" }],
      },
    ]);
  });

  it("agent.thinking produces assistant message with thinking content block", async () => {
    const events: SessionEvent[] = [
      {
        id: "sevt_2",
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "agent.thinking",
        text: "Let me think about this...",
      },
    ];

    const path = await eventsToSessionFile(events, "sess-think", workDir);
    const content = JSON.parse(await readFile(path, "utf-8"));

    expect(content).toEqual([
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Let me think about this..." }],
      },
    ]);
  });

  it("agent.tool_use + agent.tool_result produces correct tool_use/tool_result pair", async () => {
    const events: SessionEvent[] = [
      {
        id: "sevt_3",
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "agent.tool_use",
        toolUseId: "tu_abc",
        name: "read_file",
        input: { path: "/etc/hosts" },
      },
      {
        id: "sevt_4",
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "agent.tool_result",
        toolUseId: "tu_abc",
        content: [{ type: "text", text: "127.0.0.1 localhost" }],
      },
    ];

    const path = await eventsToSessionFile(events, "sess-tool", workDir);
    const content = JSON.parse(await readFile(path, "utf-8"));

    expect(content).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu_abc",
            name: "read_file",
            input: { path: "/etc/hosts" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_abc",
            content: "127.0.0.1 localhost",
          },
        ],
      },
    ]);
  });

  it("streaming events in history are skipped", async () => {
    const events: SessionEvent[] = [
      {
        id: "sevt_s1",
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "agent.message_stream_start",
      },
      {
        id: "sevt_s2",
        timestamp: "2026-01-01T00:00:00.100Z",
        type: "agent.message_chunk",
        text: "He",
      },
      {
        id: "sevt_s3",
        timestamp: "2026-01-01T00:00:00.200Z",
        type: "agent.message_chunk",
        text: "llo",
      },
      {
        id: "sevt_s4",
        timestamp: "2026-01-01T00:00:00.300Z",
        type: "agent.message_stream_end",
      },
      {
        id: "sevt_s5",
        timestamp: "2026-01-01T00:00:00.400Z",
        type: "agent.thinking_stream_start",
      },
      {
        id: "sevt_s6",
        timestamp: "2026-01-01T00:00:00.500Z",
        type: "agent.thinking_chunk",
        text: "hmm",
      },
      {
        id: "sevt_s7",
        timestamp: "2026-01-01T00:00:00.600Z",
        type: "agent.thinking_stream_end",
      },
      {
        id: "sevt_s8",
        timestamp: "2026-01-01T00:00:00.700Z",
        type: "agent.tool_use_input_stream_start",
        toolUseId: "tu_x",
        name: "bash",
      },
      {
        id: "sevt_s9",
        timestamp: "2026-01-01T00:00:00.800Z",
        type: "agent.tool_use_input_chunk",
        toolUseId: "tu_x",
        delta: '{"cmd":"ls"}',
      },
      {
        id: "sevt_s10",
        timestamp: "2026-01-01T00:00:00.900Z",
        type: "agent.tool_use_input_stream_end",
        toolUseId: "tu_x",
      },
      // The canonical version that should be included
      {
        id: "sevt_c1",
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "agent.message",
        content: [{ type: "text", text: "Hello" }],
      },
    ];

    const path = await eventsToSessionFile(events, "sess-stream", workDir);
    const content = JSON.parse(await readFile(path, "utf-8"));

    // Only the canonical agent.message should appear
    expect(content).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
      },
    ]);
  });

  it("lifecycle and span events are skipped", async () => {
    const events: SessionEvent[] = [
      {
        id: "sevt_l1",
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session.status_running",
      },
      {
        id: "sevt_l2",
        timestamp: "2026-01-01T00:00:00.100Z",
        type: "span.model_request_start",
        model: "claude-sonnet-4-20250514",
      },
      {
        id: "sevt_l3",
        timestamp: "2026-01-01T00:00:00.200Z",
        type: "span.model_first_token",
      },
      {
        id: "sevt_l4",
        timestamp: "2026-01-01T00:00:00.300Z",
        type: "agent.message",
        content: [{ type: "text", text: "Hi" }],
      },
      {
        id: "sevt_l5",
        timestamp: "2026-01-01T00:00:00.400Z",
        type: "span.model_request_end",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
      {
        id: "sevt_l6",
        timestamp: "2026-01-01T00:00:00.500Z",
        type: "session.status_idle",
      },
    ];

    const path = await eventsToSessionFile(events, "sess-lifecycle", workDir);
    const content = JSON.parse(await readFile(path, "utf-8"));

    expect(content).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi" }],
      },
    ]);
  });

  it("concurrent calls with different sessionIds do not conflict", async () => {
    const events1: SessionEvent[] = [
      {
        id: "sevt_a",
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "agent.message",
        content: [{ type: "text", text: "Message A" }],
      },
    ];
    const events2: SessionEvent[] = [
      {
        id: "sevt_b",
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "agent.message",
        content: [{ type: "text", text: "Message B" }],
      },
    ];

    const [path1, path2] = await Promise.all([
      eventsToSessionFile(events1, "sess-concurrent-1", workDir),
      eventsToSessionFile(events2, "sess-concurrent-2", workDir),
    ]);

    const content1 = JSON.parse(await readFile(path1, "utf-8"));
    const content2 = JSON.parse(await readFile(path2, "utf-8"));

    expect(content1).toEqual([
      { role: "assistant", content: [{ type: "text", text: "Message A" }] },
    ]);
    expect(content2).toEqual([
      { role: "assistant", content: [{ type: "text", text: "Message B" }] },
    ]);
    expect(path1).not.toBe(path2);
  });

  it("handles mixed canonical events in order", async () => {
    const events: SessionEvent[] = [
      {
        id: "sevt_m1",
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "agent.thinking",
        text: "Planning my approach",
      },
      {
        id: "sevt_m2",
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "agent.message",
        content: [{ type: "text", text: "I will read the file." }],
      },
      {
        id: "sevt_m3",
        timestamp: "2026-01-01T00:00:02.000Z",
        type: "agent.tool_use",
        toolUseId: "tu_mix",
        name: "read_file",
        input: { path: "/foo.txt" },
      },
      {
        id: "sevt_m4",
        timestamp: "2026-01-01T00:00:03.000Z",
        type: "agent.tool_result",
        toolUseId: "tu_mix",
        content: [{ type: "text", text: "file contents" }],
      },
      {
        id: "sevt_m5",
        timestamp: "2026-01-01T00:00:04.000Z",
        type: "agent.message",
        content: [{ type: "text", text: "Done!" }],
      },
    ];

    const path = await eventsToSessionFile(events, "sess-mixed", workDir);
    const content = JSON.parse(await readFile(path, "utf-8"));

    expect(content).toEqual([
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Planning my approach" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "I will read the file." }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu_mix",
            name: "read_file",
            input: { path: "/foo.txt" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_mix",
            content: "file contents",
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Done!" }],
      },
    ]);
  });

  it("agent.mcp_tool_use produces tool_use message with prefixed name", async () => {
    const events: SessionEvent[] = [
      {
        id: "sevt_mcp1",
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "agent.mcp_tool_use",
        toolUseId: "tu_mcp",
        serverName: "my-server",
        name: "mcp__my-server__search",
        input: { query: "hello" },
      },
      {
        id: "sevt_mcp2",
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "agent.mcp_tool_result",
        toolUseId: "tu_mcp",
        serverName: "my-server",
        content: [{ type: "text", text: "results here" }],
      },
    ];

    const path = await eventsToSessionFile(events, "sess-mcp", workDir);
    const content = JSON.parse(await readFile(path, "utf-8"));

    expect(content).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu_mcp",
            name: "mcp__my-server__search",
            input: { query: "hello" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_mcp",
            content: "results here",
          },
        ],
      },
    ]);
  });

  it("tool_result with isError flag is represented correctly", async () => {
    const events: SessionEvent[] = [
      {
        id: "sevt_te1",
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "agent.tool_use",
        toolUseId: "tu_err",
        name: "bash",
        input: { command: "rm -rf /" },
      },
      {
        id: "sevt_te2",
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "agent.tool_result",
        toolUseId: "tu_err",
        content: [{ type: "text", text: "Permission denied" }],
        isError: true,
      },
    ];

    const path = await eventsToSessionFile(events, "sess-err", workDir);
    const content = JSON.parse(await readFile(path, "utf-8"));

    expect(content[1]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_err",
          content: "Permission denied",
          is_error: true,
        },
      ],
    });
  });
});
