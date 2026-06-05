import { describe, it, expect } from "vitest";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PiAgentAdapter } from "../src/pi-agent-adapter.js";
import type { PiCliEvent } from "../src/cli-types.js";
import type {
  AdapterInput,
  SessionEvent,
  AgentMessageEvent,
  AgentThinkingEvent,
  AgentToolUseEvent,
  AgentToolResultEvent,
  SpanModelRequestEndEvent,
} from "@open-managed-agents/adapter-core";

function makeInput(prompt: string): AdapterInput {
  return {
    sessionId: "test-session",
    turnId: "test-turn",
    message: { role: "user", content: [{ type: "text", text: prompt }] },
    agent: { model: "pi-1", system: "You are helpful." },
    history: [],
  };
}

async function collectEvents(
  iterable: AsyncIterable<SessionEvent>
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const e of iterable) events.push(e);
  return events;
}

function fakeSource(events: PiCliEvent[]) {
  return async function* () {
    for (const e of events) yield e;
  };
}

describe("PiAgentAdapter", () => {
  describe("simple text turn", () => {
    const cliEvents: PiCliEvent[] = [
      { type: "session" },
      { type: "agent_start" },
      { type: "turn_start" },
      {
        type: "message_start",
        message: { role: "assistant", content: [], model: "pi-1" },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_start" },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Four." },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_end", content: "Four." },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Four." }],
          model: "pi-1",
          usage: {
            input: 100,
            output: 5,
            cacheRead: 10,
            cacheWrite: 0,
            totalTokens: 105,
            cost: { total: 0.001 },
          },
          stopReason: "stop",
        },
      },
      { type: "turn_end" },
      { type: "agent_end" },
    ];

    it("first event is session.status_running", async () => {
      const adapter = new PiAgentAdapter({
        _eventSource: fakeSource(cliEvents),
      });
      const events = await collectEvents(adapter.run(makeInput("2+2")));
      expect(events[0].type).toBe("session.status_running");
    });

    it("last event is session.status_idle", async () => {
      const adapter = new PiAgentAdapter({
        _eventSource: fakeSource(cliEvents),
      });
      const events = await collectEvents(adapter.run(makeInput("2+2")));
      expect(events[events.length - 1].type).toBe("session.status_idle");
    });

    it("emits span.model_request_start and span.model_request_end", async () => {
      const adapter = new PiAgentAdapter({
        _eventSource: fakeSource(cliEvents),
      });
      const events = await collectEvents(adapter.run(makeInput("2+2")));
      const types = events.map((e) => e.type);
      expect(types).toContain("span.model_request_start");
      expect(types).toContain("span.model_request_end");
    });

    it("emits agent.message with correct text", async () => {
      const adapter = new PiAgentAdapter({
        _eventSource: fakeSource(cliEvents),
      });
      const events = await collectEvents(adapter.run(makeInput("2+2")));
      const msg = events.find(
        (e) => e.type === "agent.message"
      ) as AgentMessageEvent;
      expect(msg).toBeDefined();
      expect(msg.content[0]).toEqual({ type: "text", text: "Four." });
    });

    it("span.model_request_end contains usage", async () => {
      const adapter = new PiAgentAdapter({
        _eventSource: fakeSource(cliEvents),
      });
      const events = await collectEvents(adapter.run(makeInput("2+2")));
      const end = events.find(
        (e) => e.type === "span.model_request_end"
      ) as SpanModelRequestEndEvent;
      expect(end.usage.inputTokens).toBe(100);
      expect(end.usage.outputTokens).toBe(5);
    });

    it("emits streaming events in correct order", async () => {
      const adapter = new PiAgentAdapter({
        _eventSource: fakeSource(cliEvents),
      });
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
    const cliEvents: PiCliEvent[] = [
      { type: "session" },
      {
        type: "message_start",
        message: { role: "assistant", content: [], model: "pi-1" },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_start" },
      },
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_delta",
          delta: "Let me think...",
        },
      },
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_end",
          content: "Let me think...",
        },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_start" },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Done." },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_end", content: "Done." },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          usage: {
            input: 50,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 70,
            cost: { total: 0.001 },
          },
        },
      },
    ];

    it("emits agent.thinking with accumulated text", async () => {
      const adapter = new PiAgentAdapter({
        _eventSource: fakeSource(cliEvents),
      });
      const events = await collectEvents(adapter.run(makeInput("think")));
      const thinking = events.find(
        (e) => e.type === "agent.thinking"
      ) as AgentThinkingEvent;
      expect(thinking).toBeDefined();
      expect(thinking.text).toBe("Let me think...");
    });

    it("emits thinking stream events", async () => {
      const adapter = new PiAgentAdapter({
        _eventSource: fakeSource(cliEvents),
      });
      const events = await collectEvents(adapter.run(makeInput("think")));
      const types = events.map((e) => e.type);
      expect(types).toContain("agent.thinking_stream_start");
      expect(types).toContain("agent.thinking_chunk");
      expect(types).toContain("agent.thinking_stream_end");
    });
  });

  describe("tool use turn", () => {
    const cliEvents: PiCliEvent[] = [
      { type: "session" },
      {
        type: "message_start",
        message: { role: "assistant", content: [], model: "pi-1" },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_start" },
      },
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_end",
          toolCall: { id: "tc_1", name: "shell", args: { command: "ls" } },
        },
      },
      {
        type: "tool_execution_end",
        toolCallId: "tc_1",
        toolName: "shell",
        result: "file1.ts\nfile2.ts",
        isError: false,
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_start" },
      },
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: "There are 2 files.",
        },
      },
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_end",
          content: "There are 2 files.",
        },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          usage: {
            input: 200,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 220,
            cost: { total: 0.002 },
          },
        },
      },
    ];

    it("emits agent.tool_use with correct name and input", async () => {
      const adapter = new PiAgentAdapter({
        _eventSource: fakeSource(cliEvents),
      });
      const events = await collectEvents(adapter.run(makeInput("ls")));
      const toolUse = events.find(
        (e) => e.type === "agent.tool_use"
      ) as AgentToolUseEvent;
      expect(toolUse).toBeDefined();
      expect(toolUse.name).toBe("shell");
      expect(toolUse.input).toEqual({ command: "ls" });
    });

    it("emits agent.tool_result with output", async () => {
      const adapter = new PiAgentAdapter({
        _eventSource: fakeSource(cliEvents),
      });
      const events = await collectEvents(adapter.run(makeInput("ls")));
      const result = events.find(
        (e) => e.type === "agent.tool_result"
      ) as AgentToolResultEvent;
      expect(result).toBeDefined();
      expect(result.content[0]).toEqual({
        type: "text",
        text: "file1.ts\nfile2.ts",
      });
      expect(result.isError).toBe(false);
    });

    it("marks error results correctly", async () => {
      const errorEvents: PiCliEvent[] = [
        { type: "session" },
        {
          type: "message_start",
          message: { role: "assistant", content: [], model: "pi-1" },
        },
        {
          type: "message_update",
          assistantMessageEvent: {
            type: "toolcall_end",
            toolCall: {
              id: "tc_2",
              name: "shell",
              args: { command: "false" },
            },
          },
        },
        {
          type: "tool_execution_end",
          toolCallId: "tc_2",
          toolName: "shell",
          result: "",
          isError: true,
        },
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            usage: {
              input: 50,
              output: 5,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 55,
              cost: { total: 0.001 },
            },
          },
        },
      ];
      const adapter = new PiAgentAdapter({
        _eventSource: fakeSource(errorEvents),
      });
      const events = await collectEvents(adapter.run(makeInput("run false")));
      const result = events.find(
        (e) => e.type === "agent.tool_result"
      ) as AgentToolResultEvent;
      expect(result.isError).toBe(true);
    });
  });

  describe("error handling", () => {
    it("emits session.error when event source throws", async () => {
      const adapter = new PiAgentAdapter({
        _eventSource: async function* () {
          throw new Error("unexpected crash");
        },
      });
      const events = await collectEvents(adapter.run(makeInput("crash")));
      const last = events[events.length - 1] as any;
      expect(last.type).toBe("session.error");
      expect(last.error.message).toBe("unexpected crash");
      expect(last.error.code).toBe("pi_agent_error");
    });

    it("never throws from the async iterable", async () => {
      const adapter = new PiAgentAdapter({
        _eventSource: async function* () {
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
      const cliEvents: PiCliEvent[] = [
        { type: "session" },
        {
          type: "message_start",
          message: { role: "assistant", content: [], model: "pi-1" },
        },
        {
          type: "message_update",
          assistantMessageEvent: { type: "text_start" },
        },
        {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "ok" },
        },
        {
          type: "message_update",
          assistantMessageEvent: { type: "text_end", content: "ok" },
        },
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            usage: {
              input: 10,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 12,
              cost: { total: 0 },
            },
          },
        },
      ];
      const adapter = new PiAgentAdapter({
        _eventSource: fakeSource(cliEvents),
      });
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

  describe("history", () => {
    it("includes prior user and assistant messages in the CLI prompt", async () => {
      let seenPrompt = "";
      const adapter = new PiAgentAdapter({
        _eventSource: async function* (prompt: string) {
          seenPrompt = prompt;
          yield {
            type: "message_update",
            assistantMessageEvent: { type: "text_end", content: "ok" },
          } as PiCliEvent;
        },
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
        },
      ];

      await collectEvents(adapter.run(input));

      expect(seenPrompt).toContain("User: Remember CODE-1");
      expect(seenPrompt).toContain("Assistant: stored CODE-1");
      expect(seenPrompt).toContain("User: What was it?");
    });

    it("continues the Pi CLI session when history is present", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "oma-pi-adapter-"));
      const commandPath = join(tmp, "fake-pi.js");
      const argsPath = join(tmp, "args.json");
      const sessionRootDir = join(tmp, "sessions");

      await writeFile(
        commandPath,
        [
          "#!/usr/bin/env node",
          "const { writeFileSync } = require('node:fs');",
          `writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
          "console.log(JSON.stringify({ type: 'message_start', message: { role: 'assistant', content: [], model: 'pi-test' } }));",
          "console.log(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_end', content: 'ok' } }));",
          "console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [], usage: { input: 1, output: 1 } } }));",
        ].join("\n"),
      );
      await chmod(commandPath, 0o755);

      const adapter = new PiAgentAdapter({
        command: commandPath,
        sessionRootDir,
      });
      const input = makeInput("What was it?");
      input.history = [
        {
          id: "sevt_agent",
          timestamp: "2026-01-01T00:00:01.000Z",
          type: "agent.message",
          content: [{ type: "text", text: "stored CODE-2" }],
        },
      ];

      await collectEvents(adapter.run(input));

      const args = JSON.parse(await readFile(argsPath, "utf-8")) as string[];
      expect(args).toContain("--session-dir");
      expect(args).toContain(join(sessionRootDir, "test-session"));
      expect(args).toContain("--continue");
      expect(args).not.toContain("--no-session");
    });
  });
});
