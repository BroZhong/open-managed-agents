import { describe, it, expect } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { PiAgentAdapter } from "../src/pi-agent-adapter.js";
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
      dispose() {},
    };
  };
}

const assistantStart: AgentSessionEvent = {
  type: "message_start",
  message: { role: "assistant", model: "claude-sonnet-4-5" } as never,
} as AgentSessionEvent;

function assistantEnd(input: number, output: number): AgentSessionEvent {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      usage: {
        input,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: input + output,
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

    it("first event is session.status_running", async () => {
      const adapter = new PiAgentAdapter({ _sessionFactory: fakeFactory(script) });
      const events = await collectEvents(adapter.run(makeInput("2+2")));
      expect(events[0].type).toBe("session.status_running");
    });

    it("last event is session.status_idle", async () => {
      const adapter = new PiAgentAdapter({ _sessionFactory: fakeFactory(script) });
      const events = await collectEvents(adapter.run(makeInput("2+2")));
      expect(events[events.length - 1].type).toBe("session.status_idle");
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
    it("includes prior user and assistant messages in the prompt", async () => {
      let seenPrompt = "";
      const adapter = new PiAgentAdapter({
        _sessionFactory: fakeFactory(
          [
            assistantStart,
            ame({ type: "text_end", contentIndex: 0, content: "ok" }),
            assistantEnd(1, 1),
          ],
          (args) => {
            seenPrompt = args.prompt;
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

      expect(seenPrompt).toContain("User: Remember CODE-1");
      expect(seenPrompt).toContain("Assistant: stored CODE-1");
      expect(seenPrompt).toContain("User: What was it?");
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
  });
});
