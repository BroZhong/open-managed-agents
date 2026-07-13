import { describe, it, expect } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  buildManagedMcpPromptSection,
  PiAgentAdapter,
} from "../src/pi-agent-adapter.js";
import type {
  PiSessionLike,
  SessionFactoryArgs,
} from "../src/pi-agent-adapter.js";
import type {
  AdapterInput,
  SessionEvent,
  AgentMessageEvent,
  AgentThinkingEvent,
  AgentToolUseEvent,
  AgentToolResultEvent,
  AgentMcpToolUseEvent,
  AgentMcpToolResultEvent,
  AgentToolUseInputStreamStartEvent,
  AgentToolUseInputChunkEvent,
  AgentToolUseInputStreamEndEvent,
  SpanModelRequestEndEvent,
} from "@open-managed-agents/adapter-core";

function makeInput(prompt: string): AdapterInput {
  return {
    sessionId: "test-session",
    turnId: "test-turn",
    message: { role: "user", content: [{ type: "text", text: prompt }] },
    agent: { model: "claude-sonnet-4-5", system: "You are helpful." },
    history: [],
  };
}

async function collectEvents(
  iterable: AsyncIterable<SessionEvent>,
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const e of iterable) events.push(e);
  return events;
}

/**
 * A fake Pi session driven by a fixed script of AgentSessionEvents. When
 * prompt() is called it replays the script through the subscriber, then emits
 * an `agent_end` so the adapter's queue completes.
 */
function fakeFactory(
  script: AgentSessionEvent[],
  hook?: (args: SessionFactoryArgs) => void,
) {
  return async (args: SessionFactoryArgs): Promise<PiSessionLike> => {
    hook?.(args);
    let listener: ((e: AgentSessionEvent) => void) | undefined;
    return {
      subscribe(l) {
        listener = l;
        return () => {
          listener = undefined;
        };
      },
      async prompt() {
        for (const e of script) listener?.(e);
        listener?.({
          type: "agent_end",
          messages: [],
          willRetry: false,
        } as AgentSessionEvent);
      },
      abort() {},
      dispose() {},
    };
  };
}

/** Replay a script that already contains its own agent_end events. */
function scriptedFactory(script: AgentSessionEvent[]) {
  return async (): Promise<PiSessionLike> => {
    let listener: ((e: AgentSessionEvent) => void) | undefined;
    return {
      subscribe(l) {
        listener = l;
        return () => {
          listener = undefined;
        };
      },
      async prompt() {
        for (const e of script) listener?.(e);
      },
      abort() {},
      dispose() {},
    };
  };
}

const assistantStart: AgentSessionEvent = {
  type: "message_start",
  message: { role: "assistant", model: "claude-sonnet-4-5" } as never,
} as AgentSessionEvent;

function assistantEnd(
  input: number,
  output: number,
  cacheRead = 0,
  cacheWrite = 0,
): AgentSessionEvent {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      usage: {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens: input + output + cacheRead + cacheWrite,
        cost: { total: 0 },
      },
    },
  } as never as AgentSessionEvent;
}

function ame(event: Record<string, unknown>): AgentSessionEvent {
  return {
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: event,
  } as never as AgentSessionEvent;
}

describe("PiAgentAdapter (SDK)", () => {
  describe("simple text turn", () => {
    const script: AgentSessionEvent[] = [
      assistantStart,
      ame({ type: "text_start", contentIndex: 0 }),
      ame({ type: "text_delta", contentIndex: 0, delta: "Four." }),
      ame({ type: "text_end", contentIndex: 0, content: "Four." }),
      assistantEnd(100, 5),
    ];

    it("emits NO session lifecycle events — the Host router owns them (issue #83)", async () => {
      const adapter = new PiAgentAdapter({ _sessionFactory: fakeFactory(script) });
      const events = await collectEvents(adapter.run(makeInput("2+2")));
      const types = events.map((e) => e.type);
      // The adapter must not double-emit lifecycle events: the router persists
      // exactly one running/idle per turn. The adapter yields content only.
      expect(types).not.toContain("session.status_running");
      expect(types).not.toContain("session.status_idle");
    });

    it("emits span.model_request_start and span.model_request_end", async () => {
      const adapter = new PiAgentAdapter({ _sessionFactory: fakeFactory(script) });
      const events = await collectEvents(adapter.run(makeInput("2+2")));
      const types = events.map((e) => e.type);
      expect(types).toContain("span.model_request_start");
      expect(types).toContain("span.model_request_end");
    });

    it("emits agent.message with correct text", async () => {
      const adapter = new PiAgentAdapter({ _sessionFactory: fakeFactory(script) });
      const events = await collectEvents(adapter.run(makeInput("2+2")));
      const msg = events.find(
        (e) => e.type === "agent.message",
      ) as AgentMessageEvent;
      expect(msg).toBeDefined();
      expect(msg.content[0]).toEqual({ type: "text", text: "Four." });
    });

    it("span.model_request_end contains usage", async () => {
      const adapter = new PiAgentAdapter({ _sessionFactory: fakeFactory(script) });
      const events = await collectEvents(adapter.run(makeInput("2+2")));
      const end = events.find(
        (e) => e.type === "span.model_request_end",
      ) as SpanModelRequestEndEvent;
      expect(end.usage.inputTokens).toBe(100);
      expect(end.usage.outputTokens).toBe(5);
    });

    it("normalizes cache reads and writes into total input usage", async () => {
      const cachedScript: AgentSessionEvent[] = [
        assistantStart,
        ame({ type: "text_start", contentIndex: 0 }),
        ame({ type: "text_end", contentIndex: 0, content: "Cached." }),
        assistantEnd(60, 5, 30, 10),
      ];
      const adapter = new PiAgentAdapter({
        _sessionFactory: fakeFactory(cachedScript),
      });
      const events = await collectEvents(adapter.run(makeInput("cached")));
      const end = events.find(
        (event) => event.type === "span.model_request_end",
      ) as SpanModelRequestEndEvent;

      expect(end.usage).toEqual({
        inputTokens: 100,
        outputTokens: 5,
        cacheReadTokens: 30,
        cacheWriteTokens: 10,
      });
    });

    it("emits streaming events in correct order", async () => {
      const adapter = new PiAgentAdapter({ _sessionFactory: fakeFactory(script) });
      const events = await collectEvents(adapter.run(makeInput("2+2")));
      const types = events.map((e) => e.type);
      const streamStart = types.indexOf("agent.message_stream_start");
      const chunk = types.indexOf("agent.message_chunk");
      const streamEnd = types.indexOf("agent.message_stream_end");
      const message = types.indexOf("agent.message");
      expect(streamStart).toBeGreaterThan(-1);
      expect(chunk).toBeGreaterThan(streamStart);
      expect(streamEnd).toBeGreaterThan(chunk);
      expect(message).toBeGreaterThan(streamEnd);
    });
  });

  describe("thinking turn", () => {
    const script: AgentSessionEvent[] = [
      assistantStart,
      ame({ type: "thinking_start", contentIndex: 0 }),
      ame({ type: "thinking_delta", contentIndex: 0, delta: "Let me think..." }),
      ame({ type: "thinking_end", contentIndex: 0, content: "Let me think..." }),
      ame({ type: "text_start", contentIndex: 1 }),
      ame({ type: "text_delta", contentIndex: 1, delta: "Done." }),
      ame({ type: "text_end", contentIndex: 1, content: "Done." }),
      assistantEnd(50, 20),
    ];

    it("emits agent.thinking with accumulated text", async () => {
      const adapter = new PiAgentAdapter({ _sessionFactory: fakeFactory(script) });
      const events = await collectEvents(adapter.run(makeInput("think")));
      const thinking = events.find(
        (e) => e.type === "agent.thinking",
      ) as AgentThinkingEvent;
      expect(thinking).toBeDefined();
      expect(thinking.text).toBe("Let me think...");
    });

    it("emits thinking stream events", async () => {
      const adapter = new PiAgentAdapter({ _sessionFactory: fakeFactory(script) });
      const events = await collectEvents(adapter.run(makeInput("think")));
      const types = events.map((e) => e.type);
      expect(types).toContain("agent.thinking_stream_start");
      expect(types).toContain("agent.thinking_chunk");
      expect(types).toContain("agent.thinking_stream_end");
    });
  });

  describe("tool use turn", () => {
    const script: AgentSessionEvent[] = [
      assistantStart,
      ame({ type: "toolcall_start", contentIndex: 0 }),
      ame({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: {
          type: "toolCall",
          id: "tc_1",
          name: "exec",
          arguments: { command: "ls" },
        },
      }),
      {
        type: "tool_execution_end",
        toolCallId: "tc_1",
        toolName: "exec",
        result: "file1.ts\nfile2.ts",
        isError: false,
      } as AgentSessionEvent,
      ame({ type: "text_start", contentIndex: 1 }),
      ame({ type: "text_delta", contentIndex: 1, delta: "There are 2 files." }),
      ame({ type: "text_end", contentIndex: 1, content: "There are 2 files." }),
      assistantEnd(200, 20),
    ];

    it("emits agent.tool_use with correct name and input", async () => {
      const adapter = new PiAgentAdapter({ _sessionFactory: fakeFactory(script) });
      const events = await collectEvents(adapter.run(makeInput("ls")));
      const toolUse = events.find(
        (e) => e.type === "agent.tool_use",
      ) as AgentToolUseEvent;
      expect(toolUse).toBeDefined();
      expect(toolUse.name).toBe("exec");
      expect(toolUse.input).toEqual({ command: "ls" });
    });

    it("emits agent.tool_result with output", async () => {
      const adapter = new PiAgentAdapter({ _sessionFactory: fakeFactory(script) });
      const events = await collectEvents(adapter.run(makeInput("ls")));
      const result = events.find(
        (e) => e.type === "agent.tool_result",
      ) as AgentToolResultEvent;
      expect(result).toBeDefined();
      expect(result.content[0]).toEqual({
        type: "text",
        text: "file1.ts\nfile2.ts",
      });
      expect(result.isError).toBe(false);
    });

    it("tool_result.toolUseId equals the tool_use's toolUseId (toolCall.id pairing)", async () => {
      const adapter = new PiAgentAdapter({ _sessionFactory: fakeFactory(script) });
      const events = await collectEvents(adapter.run(makeInput("ls")));
      const toolUse = events.find(
        (e) => e.type === "agent.tool_use",
      ) as AgentToolUseEvent;
      const result = events.find(
        (e) => e.type === "agent.tool_result",
      ) as AgentToolResultEvent;
      expect(result.toolUseId).toBe("tc_1");
      expect(result.toolUseId).toBe(toolUse.toolUseId);
    });

    it("marks error results correctly", async () => {
      const errorScript: AgentSessionEvent[] = [
        assistantStart,
        ame({
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: {
            type: "toolCall",
            id: "tc_2",
            name: "exec",
            arguments: { command: "false" },
          },
        }),
        {
          type: "tool_execution_end",
          toolCallId: "tc_2",
          toolName: "exec",
          result: "",
          isError: true,
        } as AgentSessionEvent,
        assistantEnd(50, 5),
      ];
      const adapter = new PiAgentAdapter({
        _sessionFactory: fakeFactory(errorScript),
      });
      const events = await collectEvents(adapter.run(makeInput("run false")));
      const result = events.find(
        (e) => e.type === "agent.tool_result",
      ) as AgentToolResultEvent;
      expect(result.isError).toBe(true);
    });
  });

  describe("MCP proxy tool turn", () => {
    const script: AgentSessionEvent[] = [
      assistantStart,
      ame({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: {
          type: "toolCall",
          id: "mcp_tc_1",
          name: "mcp",
          arguments: {
            tool: "session_data_query_recent_sessions",
            args: '{"days":7,"limit":25}',
          },
        },
      }),
      {
        type: "tool_execution_end",
        toolCallId: "mcp_tc_1",
        toolName: "mcp",
        result: {
          content: [{ type: "text", text: '{"sessions":[]}' }],
        },
        isError: false,
      } as AgentSessionEvent,
      assistantEnd(200, 20),
    ];

    function makeMcpInput(): AdapterInput {
      const input = makeInput("Review recent sessions");
      input.agent.mcpServers = [
        { name: "session-data", command: "node", args: ["server.js"] },
      ];
      return input;
    }

    it("emits canonical MCP use/result events for a proxy tool call", async () => {
      const adapter = new PiAgentAdapter({ _sessionFactory: fakeFactory(script) });
      const events = await collectEvents(adapter.run(makeMcpInput()));

      const toolUse = events.find(
        (event) => event.type === "agent.mcp_tool_use",
      ) as AgentMcpToolUseEvent;
      expect(toolUse).toMatchObject({
        toolUseId: "mcp_tc_1",
        serverName: "session-data",
        name: "query_recent_sessions",
        input: { days: 7, limit: 25 },
      });
      expect(events.some((event) => event.type === "agent.tool_use")).toBe(false);

      const result = events.find(
        (event) => event.type === "agent.mcp_tool_result",
      ) as AgentMcpToolResultEvent;
      expect(result).toMatchObject({
        toolUseId: "mcp_tc_1",
        serverName: "session-data",
        isError: false,
      });
      expect(result.content).toEqual([
        { type: "text", text: '{"sessions":[]}' },
      ]);
      expect(events.some((event) => event.type === "agent.tool_result")).toBe(false);
    });

    it("keeps MCP discovery operations as ordinary proxy-tool events", async () => {
      const discoveryScript: AgentSessionEvent[] = [
        assistantStart,
        ame({
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: {
            type: "toolCall",
            id: "mcp_search_1",
            name: "mcp",
            arguments: { search: "sessions" },
          },
        }),
        {
          type: "tool_execution_end",
          toolCallId: "mcp_search_1",
          toolName: "mcp",
          result: "query_recent_sessions",
          isError: false,
        } as AgentSessionEvent,
        assistantEnd(50, 5),
      ];
      const adapter = new PiAgentAdapter({
        _sessionFactory: fakeFactory(discoveryScript),
      });
      const events = await collectEvents(adapter.run(makeMcpInput()));

      expect(events).toContainEqual(
        expect.objectContaining({
          type: "agent.tool_use",
          toolUseId: "mcp_search_1",
          name: "mcp",
          input: { search: "sessions" },
        }),
      );
      expect(events.some((event) => event.type === "agent.mcp_tool_use")).toBe(
        false,
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "agent.tool_result",
          toolUseId: "mcp_search_1",
        }),
      );
      expect(
        events.some((event) => event.type === "agent.mcp_tool_result"),
      ).toBe(false);
    });

    it("keeps a recognized gateway action local when tool is also present", async () => {
      const actionScript: AgentSessionEvent[] = [
        assistantStart,
        ame({
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: {
            type: "toolCall",
            id: "mcp_action_1",
            name: "mcp",
            arguments: {
              action: "ui-messages",
              tool: "session_data_query_recent_sessions",
              args: '{"days":7}',
            },
          },
        }),
        {
          type: "tool_execution_end",
          toolCallId: "mcp_action_1",
          toolName: "mcp",
          result: "No completed MCP UI sessions",
          isError: false,
        } as AgentSessionEvent,
        assistantEnd(20, 2),
      ];
      const adapter = new PiAgentAdapter({
        _sessionFactory: fakeFactory(actionScript),
      });
      const events = await collectEvents(adapter.run(makeMcpInput()));

      expect(events).toContainEqual(
        expect.objectContaining({
          type: "agent.tool_use",
          toolUseId: "mcp_action_1",
          name: "mcp",
          input: {
            action: "ui-messages",
            tool: "session_data_query_recent_sessions",
            args: '{"days":7}',
          },
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "agent.tool_result",
          toolUseId: "mcp_action_1",
        }),
      );
      expect(
        events.some((event) => event.type === "agent.mcp_tool_use"),
      ).toBe(false);
      expect(
        events.some((event) => event.type === "agent.mcp_tool_result"),
      ).toBe(false);
    });
  });

  describe("tool_use input stream carries id/name from partial", () => {
    // The SDK carries the tool call's id/name in `partial.content[contentIndex]`
    // from the very first stream event (args fill in later). The translator must
    // surface them on the streamed input events, not just on the final tool_use —
    // otherwise concurrent tool calls' chunks can't be attributed.
    function toolCallBlock(id: string, name: string, args: object) {
      return { type: "toolCall", id, name, arguments: args };
    }

    it("stream start/chunk/end carry the real toolUseId + name", async () => {
      const partial = {
        role: "assistant",
        content: [toolCallBlock("tc_9", "write_file", {})],
      };
      const script: AgentSessionEvent[] = [
        assistantStart,
        ame({ type: "toolcall_start", contentIndex: 0, partial }),
        ame({ type: "toolcall_delta", contentIndex: 0, delta: '{"path":', partial }),
        ame({ type: "toolcall_end", contentIndex: 0, partial,
          toolCall: toolCallBlock("tc_9", "write_file", { path: "a.txt" }) }),
        assistantEnd(10, 2),
      ];
      const adapter = new PiAgentAdapter({ _sessionFactory: fakeFactory(script) });
      const events = await collectEvents(adapter.run(makeInput("write")));

      const start = events.find(
        (e) => e.type === "agent.tool_use_input_stream_start",
      ) as AgentToolUseInputStreamStartEvent;
      expect(start.toolUseId).toBe("tc_9");
      expect(start.name).toBe("write_file");

      const chunk = events.find(
        (e) => e.type === "agent.tool_use_input_chunk",
      ) as AgentToolUseInputChunkEvent;
      expect(chunk.toolUseId).toBe("tc_9");

      const end = events.find(
        (e) => e.type === "agent.tool_use_input_stream_end",
      ) as AgentToolUseInputStreamEndEvent;
      expect(end.toolUseId).toBe("tc_9");
    });

    it("concurrent tool calls keep distinct ids by contentIndex", async () => {
      // Two tool calls at contentIndex 0 and 1; both blocks live in `partial`.
      const partial = {
        role: "assistant",
        content: [
          toolCallBlock("tc_a", "read_file", {}),
          toolCallBlock("tc_b", "exec", {}),
        ],
      };
      const script: AgentSessionEvent[] = [
        assistantStart,
        ame({ type: "toolcall_start", contentIndex: 0, partial }),
        ame({ type: "toolcall_start", contentIndex: 1, partial }),
        ame({ type: "toolcall_delta", contentIndex: 1, delta: "{}", partial }),
        ame({ type: "toolcall_delta", contentIndex: 0, delta: "{}", partial }),
        assistantEnd(10, 2),
      ];
      const adapter = new PiAgentAdapter({ _sessionFactory: fakeFactory(script) });
      const events = await collectEvents(adapter.run(makeInput("go")));

      const starts = events.filter(
        (e) => e.type === "agent.tool_use_input_stream_start",
      ) as AgentToolUseInputStreamStartEvent[];
      expect(starts.map((s) => s.toolUseId)).toEqual(["tc_a", "tc_b"]);
      expect(starts.map((s) => s.name)).toEqual(["read_file", "exec"]);

      const chunks = events.filter(
        (e) => e.type === "agent.tool_use_input_chunk",
      ) as AgentToolUseInputChunkEvent[];
      // Deltas arrived in order idx1 then idx0 — each must carry its own id.
      expect(chunks.map((c) => c.toolUseId)).toEqual(["tc_b", "tc_a"]);
    });
  });

  describe("error handling", () => {
    it("keeps consuming events after an agent_end that Pi marks for retry", async () => {
      const script: AgentSessionEvent[] = [
        assistantStart,
        {
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "temporary provider failure",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { total: 0 },
            },
          },
        } as never as AgentSessionEvent,
        {
          type: "agent_end",
          messages: [],
          willRetry: true,
        } as AgentSessionEvent,
        assistantStart,
        ame({ type: "text_start", contentIndex: 0 }),
        ame({ type: "text_delta", contentIndex: 0, delta: "Recovered." }),
        ame({ type: "text_end", contentIndex: 0, content: "Recovered." }),
        assistantEnd(20, 3),
        {
          type: "agent_end",
          messages: [],
          willRetry: false,
        } as AgentSessionEvent,
      ];
      const adapter = new PiAgentAdapter({
        _sessionFactory: scriptedFactory(script),
      });

      const events = await collectEvents(adapter.run(makeInput("retry")));

      expect(events).toContainEqual(
        expect.objectContaining({
          type: "agent.message",
          content: [{ type: "text", text: "Recovered." }],
        }),
      );
      expect(events.filter((event) => event.type === "session.error")).toHaveLength(0);
    });

    it("keeps consuming after agent_end(false) when prompt() performs overflow recovery", async () => {
      const script: AgentSessionEvent[] = [
        assistantStart,
        {
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "context window overflow",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { total: 0 },
            },
          },
        } as never as AgentSessionEvent,
        {
          type: "agent_end",
          messages: [],
          // Pi's overflow path reports false here, then Session.prompt()
          // compacts and calls agent.continue() before the promise settles.
          willRetry: false,
        } as AgentSessionEvent,
        assistantStart,
        ame({ type: "text_start", contentIndex: 0 }),
        ame({ type: "text_delta", contentIndex: 0, delta: "After compaction." }),
        ame({
          type: "text_end",
          contentIndex: 0,
          content: "After compaction.",
        }),
        assistantEnd(20, 3),
        {
          type: "agent_end",
          messages: [],
          willRetry: false,
        } as AgentSessionEvent,
      ];
      const adapter = new PiAgentAdapter({
        _sessionFactory: scriptedFactory(script),
      });

      const events = await collectEvents(adapter.run(makeInput("overflow")));

      expect(events).toContainEqual(
        expect.objectContaining({
          type: "agent.message",
          content: [{ type: "text", text: "After compaction." }],
        }),
      );
      expect(events.filter((event) => event.type === "session.error")).toHaveLength(0);
    });

    it("emits one session.error when Pi exhausts retries with a provider error", async () => {
      const providerFailure = (message: string): AgentSessionEvent =>
        ({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: message,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { total: 0 },
            },
          },
        }) as never as AgentSessionEvent;
      const script: AgentSessionEvent[] = [
        assistantStart,
        providerFailure("temporary provider failure"),
        {
          type: "agent_end",
          messages: [],
          willRetry: true,
        } as AgentSessionEvent,
        assistantStart,
        providerFailure("provider blocked the final attempt"),
        {
          type: "agent_end",
          messages: [],
          willRetry: false,
        } as AgentSessionEvent,
      ];
      const adapter = new PiAgentAdapter({
        _sessionFactory: scriptedFactory(script),
      });

      const events = await collectEvents(adapter.run(makeInput("fail")));
      const errors = events.filter(
        (event) => event.type === "session.error",
      ) as Array<SessionEvent & { error: { message: string; code: string } }>;

      expect(errors).toHaveLength(1);
      expect(errors[0]?.error).toEqual({
        message: "provider blocked the final attempt",
        code: "pi_agent_error",
      });
    });

    it("emits session.error when the session factory throws", async () => {
      const adapter = new PiAgentAdapter({
        _sessionFactory: async () => {
          throw new Error("unexpected crash");
        },
      });
      const events = await collectEvents(adapter.run(makeInput("crash")));
      const last = events[events.length - 1] as SessionEvent & {
        error?: { message: string; code: string };
      };
      expect(last.type).toBe("session.error");
      expect(last.error?.message).toBe("unexpected crash");
      expect(last.error?.code).toBe("pi_agent_error");
    });

    it("emits session.error when prompt() rejects (model/auth failure)", async () => {
      const adapter = new PiAgentAdapter({
        _sessionFactory: async () => ({
          subscribe: () => () => {},
          prompt: async () => {
            throw new Error("no API key configured");
          },
          abort: () => {},
          dispose: () => {},
        }),
      });
      const events = await collectEvents(adapter.run(makeInput("fail")));
      const last = events[events.length - 1] as SessionEvent & {
        error?: { message: string; code: string };
      };
      expect(last.type).toBe("session.error");
      expect(last.error?.message).toBe("no API key configured");
      expect(last.error?.code).toBe("pi_agent_error");
    });

    it("never throws from the async iterable", async () => {
      const adapter = new PiAgentAdapter({
        _sessionFactory: async () => {
          throw new Error("boom");
        },
      });
      const events = await collectEvents(adapter.run(makeInput("fail")));
      expect(events.length).toBeGreaterThan(0);
      expect(events[events.length - 1].type).toBe("session.error");
    });
  });

  describe("abort signal (issue #84)", () => {
    it("aborting input.signal calls the session's native abort() and lets run() complete", async () => {
      // A hung turn: prompt() never settles until abort() is called (a tool exec
      // that never returns is the real cause). Aborting the controller must reach
      // the session's native abort(), which settles prompt() → closes the queue →
      // the for-await ends → run() completes. Without the fix run() would hang.
      let abortCalled = false;
      const adapter = new PiAgentAdapter({
        _sessionFactory: async (): Promise<PiSessionLike> => {
          let settlePrompt: (() => void) | undefined;
          let listener: ((e: AgentSessionEvent) => void) | undefined;
          return {
            subscribe(l) {
              listener = l;
              return () => {
                listener = undefined;
              };
            },
            // Never resolves on its own — only when abort() fires.
            prompt() {
              return new Promise<void>((resolve) => {
                settlePrompt = resolve;
              });
            },
            abort() {
              abortCalled = true;
              // Pi's abort settles the turn: emit agent_end (closes the queue),
              // then resolve prompt().
              listener?.({
                type: "agent_end",
                messages: [],
                willRetry: false,
              } as AgentSessionEvent);
              settlePrompt?.();
            },
            dispose() {},
          };
        },
      });

      const controller = new AbortController();
      const input = makeInput("hang");
      input.signal = controller.signal;

      const events: SessionEvent[] = [];
      const runPromise = (async () => {
        for await (const e of adapter.run(input)) events.push(e);
      })();

      // Let the turn wedge, then interrupt.
      await new Promise((r) => setTimeout(r, 10));
      controller.abort();

      await runPromise; // must resolve — proves the hang was broken.
      expect(abortCalled).toBe(true);
      // The adapter no longer emits lifecycle events (issue #83); run()
      // completing is itself the proof the hang was broken.
      const abortTypes = events.map((e) => e.type);
      expect(abortTypes).not.toContain("session.status_idle");
    });

    it("a signal already aborted before run() aborts the session immediately", async () => {
      let abortCalled = false;
      const adapter = new PiAgentAdapter({
        _sessionFactory: async (): Promise<PiSessionLike> => {
          let listener: ((e: AgentSessionEvent) => void) | undefined;
          let aborted = false;
          return {
            subscribe(l) {
              listener = l;
              return () => {
                listener = undefined;
              };
            },
            prompt() {
              // The adapter observes the already-aborted signal before prompt.
              // Model Pi's prompt settlement after that native abort rather
              // than relying on agent_end to terminate the adapter queue.
              if (aborted) return Promise.resolve();
              return new Promise<void>(() => {
                /* never settles on its own */
              });
            },
            abort() {
              abortCalled = true;
              aborted = true;
              listener?.({
                type: "agent_end",
                messages: [],
                willRetry: false,
              } as AgentSessionEvent);
            },
            dispose() {},
          };
        },
      });

      const controller = new AbortController();
      controller.abort(); // already aborted before the run starts
      const input = makeInput("go");
      input.signal = controller.signal;

      await collectEvents(adapter.run(input));
      expect(abortCalled).toBe(true);
    });
  });

  describe("statelessness", () => {
    it("concurrent runs produce independent events", async () => {
      const script: AgentSessionEvent[] = [
        assistantStart,
        ame({ type: "text_start", contentIndex: 0 }),
        ame({ type: "text_delta", contentIndex: 0, delta: "ok" }),
        ame({ type: "text_end", contentIndex: 0, content: "ok" }),
        assistantEnd(10, 2),
      ];
      const adapter = new PiAgentAdapter({ _sessionFactory: fakeFactory(script) });
      const [events1, events2] = await Promise.all([
        collectEvents(adapter.run(makeInput("a"))),
        collectEvents(adapter.run(makeInput("b"))),
      ]);
      const ids1 = events1.map((e) => e.id);
      const ids2 = events2.map((e) => e.id);
      const overlap = ids1.filter((id) => ids2.includes(id));
      expect(overlap).toHaveLength(0);
    });
  });

  describe("history + model", () => {
    it("prompts with only the current turn; prior turns become structured history (ADR-0003)", async () => {
      let seenPrompt = "";
      let seenHistory: SessionFactoryArgs["historyMessages"] = [];
      const adapter = new PiAgentAdapter({
        _sessionFactory: fakeFactory(
          [
            assistantStart,
            ame({ type: "text_end", contentIndex: 0, content: "ok" }),
            assistantEnd(1, 1),
          ],
          (args) => {
            seenPrompt = args.prompt;
            seenHistory = args.historyMessages;
          },
        ),
      });

      const input = makeInput("What was it?");
      input.history = [
        {
          id: "sevt_user",
          timestamp: "2026-01-01T00:00:00.000Z",
          type: "user.message",
          data: { content: [{ type: "text", text: "Remember CODE-1" }] },
        } as unknown as SessionEvent,
        {
          id: "sevt_agent",
          timestamp: "2026-01-01T00:00:01.000Z",
          type: "agent.message",
          content: [{ type: "text", text: "stored CODE-1" }],
        } as SessionEvent,
      ];

      await collectEvents(adapter.run(input));

      // The current turn is passed verbatim (no flattened history blob).
      expect(seenPrompt).toBe("What was it?");
      // Prior turns are rebuilt as structured messages, not concatenated text.
      expect(seenHistory).toHaveLength(2);
      expect(seenHistory[0]).toMatchObject({
        role: "user",
        content: [{ type: "text", text: "Remember CODE-1" }],
      });
      expect(seenHistory[1]).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "stored CODE-1" }],
      });
    });

    it("forwards agent.system into resource-loader appendSystemPrompt", async () => {
      let opts: SessionFactoryArgs["resourceLoaderOptions"] | undefined;
      const adapter = new PiAgentAdapter({
        _sessionFactory: fakeFactory(
          [assistantStart, assistantEnd(1, 1)],
          (args) => {
            opts = args.resourceLoaderOptions;
          },
        ),
      });
      // makeInput sets agent.system = "You are helpful." — previously discarded.
      await collectEvents(adapter.run(makeInput("hi")));
      expect(opts?.appendSystemPrompt).toEqual(["You are helpful."]);
      expect(opts?.additionalSkillPaths).toEqual([]);
      expect(opts?.noContextFiles).toBe(true);
    });

    it("tells the model to discover exact managed MCP proxy identifiers", async () => {
      let opts: SessionFactoryArgs["resourceLoaderOptions"] | undefined;
      const adapter = new PiAgentAdapter({
        _sessionFactory: fakeFactory(
          [assistantStart, assistantEnd(1, 1)],
          (args) => {
            opts = args.resourceLoaderOptions;
          },
        ),
      });
      const input = makeInput("review recent sessions");
      input.agent.mcpServers = [
        { name: "session-data", command: "node", args: ["server.js"] },
      ];

      await collectEvents(adapter.run(input));

      expect(opts?.appendSystemPrompt).toEqual([
        "You are helpful.",
        expect.stringMatching(/<managed_mcp>[\s\S]*"session-data"/),
      ]);
      const section = opts?.appendSystemPrompt[1] ?? "";
      expect(section).toContain("`connect`");
      expect(section).toContain('"session-data" -> "session_data_"');
      expect(section).toContain("exact `tool` identifier");
      expect(section).toContain("Do not guess or strip the server prefix");
      expect(section).not.toContain("server.js");
    });

    it("does not inject an MCP prompt section without configured servers", () => {
      expect(buildManagedMcpPromptSection(undefined)).toBe("");
    });

    it("assembles appendSystemPrompt (system first) + skillPaths per run()", async () => {
      let opts: SessionFactoryArgs["resourceLoaderOptions"] | undefined;
      const adapter = new PiAgentAdapter({
        _sessionFactory: fakeFactory(
          [assistantStart, assistantEnd(1, 1)],
          (args) => {
            opts = args.resourceLoaderOptions;
          },
        ),
      });
      const input = makeInput("hi");
      input.agent.system = "BASE";
      input.agent.appendSystemPrompt = ["IDENTITY", "SOUL"];
      input.agent.skillPaths = ["/tmp/skills/a", "/tmp/skills/b"];
      await collectEvents(adapter.run(input));
      expect(opts?.appendSystemPrompt).toEqual(["BASE", "IDENTITY", "SOUL"]);
      expect(opts?.additionalSkillPaths).toEqual([
        "/tmp/skills/a",
        "/tmp/skills/b",
      ]);
    });

    it("drops empty/whitespace system so no blank instruction block is injected", async () => {
      let opts: SessionFactoryArgs["resourceLoaderOptions"] | undefined;
      const adapter = new PiAgentAdapter({
        _sessionFactory: fakeFactory(
          [assistantStart, assistantEnd(1, 1)],
          (args) => {
            opts = args.resourceLoaderOptions;
          },
        ),
      });
      const input = makeInput("hi");
      input.agent.system = "   ";
      input.agent.appendSystemPrompt = ["", "REAL"];
      await collectEvents(adapter.run(input));
      expect(opts?.appendSystemPrompt).toEqual(["REAL"]);
    });

    it("resolves the model and passes it to the factory", async () => {
      let resolved: unknown;
      const adapter = new PiAgentAdapter({
        _sessionFactory: fakeFactory(
          [assistantStart, assistantEnd(1, 1)],
          (args) => {
            resolved = args.model;
          },
        ),
      });
      await collectEvents(adapter.run(makeInput("hi")));
      // A real Pi Model object with provider + id.
      expect(resolved).toBeDefined();
      expect((resolved as { provider?: string }).provider).toBe("anthropic");
    });

    it("agent.message carries origin provider/model from message_start", async () => {
      const start: AgentSessionEvent = {
        type: "message_start",
        message: {
          role: "assistant",
          provider: "anthropic",
          api: "anthropic-messages",
          model: "claude-sonnet-4-5",
        },
      } as never as AgentSessionEvent;
      const adapter = new PiAgentAdapter({
        _sessionFactory: fakeFactory([
          start,
          ame({ type: "text_start", contentIndex: 0 }),
          ame({ type: "text_end", contentIndex: 0, content: "hi" }),
          assistantEnd(1, 1),
        ]),
      });
      const events = await collectEvents(adapter.run(makeInput("hi")));
      const msg = events.find(
        (e) => e.type === "agent.message",
      ) as AgentMessageEvent & {
        provider?: string;
        api?: string;
        model?: string;
      };
      expect(msg.provider).toBe("anthropic");
      expect(msg.api).toBe("anthropic-messages");
      expect(msg.model).toBe("claude-sonnet-4-5");
    });

    it("round-trips a tool-call turn through the event log into structured history", async () => {
      // Turn 1: assistant calls a tool, gets a result, then answers.
      const turn1Script: AgentSessionEvent[] = [
        assistantStart,
        ame({
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: {
            type: "toolCall",
            id: "tc_1",
            name: "exec",
            arguments: { command: "ls" },
          },
        }),
        {
          type: "tool_execution_end",
          toolCallId: "tc_1",
          toolName: "exec",
          result: "a.ts\nb.ts",
          isError: false,
        } as AgentSessionEvent,
        ame({ type: "text_start", contentIndex: 1 }),
        ame({ type: "text_end", contentIndex: 1, content: "2 files." }),
        assistantEnd(10, 5),
      ];
      const adapter1 = new PiAgentAdapter({
        _sessionFactory: fakeFactory(turn1Script),
      });
      const turn1Events = await collectEvents(adapter1.run(makeInput("count")));

      // Reshape emitted canonical events as history does on the wire
      // (`{ type, ...body }`), prepending the user's turn-1 prompt.
      const canonical = new Set([
        "agent.message",
        "agent.tool_use",
        "agent.tool_result",
      ]);
      const history: SessionEvent[] = [
        {
          id: "sevt_u1",
          timestamp: "t",
          type: "user.message",
          data: { content: [{ type: "text", text: "count" }] },
        } as unknown as SessionEvent,
        ...turn1Events.filter((e) => canonical.has(e.type)),
      ];

      // Turn 2: assert the rebuilt structured history seen by the factory.
      let seenHistory: SessionFactoryArgs["historyMessages"] = [];
      const adapter2 = new PiAgentAdapter({
        _sessionFactory: fakeFactory(
          [assistantStart, ame({ type: "text_end", contentIndex: 0, content: "ok" }), assistantEnd(1, 1)],
          (args) => {
            seenHistory = args.historyMessages;
          },
        ),
      });
      const input2 = makeInput("and again?");
      input2.history = history;
      await collectEvents(adapter2.run(input2));

      // user, assistant(toolCall), toolResult, assistant(text)
      expect(seenHistory.map((m) => m.role)).toEqual([
        "user",
        "assistant",
        "toolResult",
        "assistant",
      ]);
      const assistantWithTool = seenHistory[1] as {
        content: Array<{ type: string; id?: string }>;
      };
      const toolCall = assistantWithTool.content.find((c) => c.type === "toolCall");
      const toolResult = seenHistory[2] as { toolCallId: string };
      // Tool id survived the event-log round-trip byte-for-byte.
      expect(toolCall?.id).toBe("tc_1");
      expect(toolResult.toolCallId).toBe("tc_1");
    });

    it("round-trips a canonical MCP turn back through Pi's generic gateway", async () => {
      const turn1Script: AgentSessionEvent[] = [
        assistantStart,
        ame({
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: {
            type: "toolCall",
            id: "mcp_tc_1",
            name: "mcp",
            arguments: {
              tool: "session_data_query_recent_sessions",
              args: '{"days":7}',
            },
          },
        }),
        {
          type: "tool_execution_end",
          toolCallId: "mcp_tc_1",
          toolName: "mcp",
          result: '{"sessions":[]}',
          isError: true,
        } as AgentSessionEvent,
        ame({ type: "text_start", contentIndex: 1 }),
        ame({
          type: "text_end",
          contentIndex: 1,
          content: "The query failed.",
        }),
        assistantEnd(10, 5),
      ];
      const adapter1 = new PiAgentAdapter({
        _sessionFactory: fakeFactory(turn1Script),
      });
      const input1 = makeInput("review recent sessions");
      input1.agent.mcpServers = [
        { name: "session-data", command: "node", args: ["server.js"] },
      ];
      const turn1Events = await collectEvents(adapter1.run(input1));

      const canonical = new Set([
        "agent.message",
        "agent.mcp_tool_use",
        "agent.mcp_tool_result",
      ]);
      const history: SessionEvent[] = [
        {
          id: "sevt_u1",
          timestamp: "t",
          type: "user.message",
          data: {
            content: [{ type: "text", text: "review recent sessions" }],
          },
        } as unknown as SessionEvent,
        ...turn1Events.filter((event) => canonical.has(event.type)),
      ];

      let seenHistory: SessionFactoryArgs["historyMessages"] = [];
      const adapter2 = new PiAgentAdapter({
        _sessionFactory: fakeFactory(
          [assistantStart, assistantEnd(1, 1)],
          (args) => {
            seenHistory = args.historyMessages;
          },
        ),
      });
      const input2 = makeInput("try again");
      input2.agent.mcpServers = input1.agent.mcpServers;
      input2.history = history;
      await collectEvents(adapter2.run(input2));

      expect(seenHistory.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "toolResult",
        "assistant",
      ]);
      const assistantWithTool = seenHistory[1] as unknown as {
        content: Array<Record<string, unknown>>;
      };
      expect(assistantWithTool.content).toContainEqual({
        type: "toolCall",
        id: "mcp_tc_1",
        name: "mcp",
        arguments: {
          tool: "session_data_query_recent_sessions",
          args: '{"days":7}',
          server: "session-data",
        },
      });
      expect(seenHistory[2]).toMatchObject({
        role: "toolResult",
        toolCallId: "mcp_tc_1",
        toolName: "mcp",
        content: [{ type: "text", text: '{"sessions":[]}' }],
        isError: true,
      });
    });
  });
});
