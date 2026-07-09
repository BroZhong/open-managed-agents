import { describe, it, expect } from "vitest";
import { CodexAdapter } from "../src/codex-adapter.js";
import type { CodexCliEvent } from "../src/cli-types.js";
import type {
  AdapterInput,
  SessionEvent,
  AgentToolUseEvent,
  AgentToolResultEvent,
  AgentMessageEvent,
  SpanModelRequestEndEvent,
} from "@open-managed-agents/adapter-core";

function makeInput(prompt: string): AdapterInput {
  return {
    sessionId: "test-session",
    turnId: "test-turn",
    message: { role: "user", content: [{ type: "text", text: prompt }] },
    agent: { model: "gpt-5.5", system: "You are helpful." },
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

function fakeSource(events: CodexCliEvent[]) {
  return async function* () {
    for (const e of events) yield e;
  };
}

describe("CodexAdapter", () => {
  describe("simple text turn", () => {
    const cliEvents: CodexCliEvent[] = [
      { type: "thread.started", thread_id: "t1" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "Four." },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          cached_input_tokens: 10,
          output_tokens: 5,
          reasoning_output_tokens: 0,
        },
      },
    ];

    it("emits NO session lifecycle events — the Host router owns them (issue #83)", async () => {
      const adapter = new CodexAdapter({ _eventSource: fakeSource(cliEvents) });
      const events = await collectEvents(adapter.run(makeInput("2+2")));
      const types = events.map((e) => e.type);
      expect(types).not.toContain("session.status_running");
      expect(types).not.toContain("session.status_idle");
    });

    it("emits span.model_request_start and span.model_request_end", async () => {
      const adapter = new CodexAdapter({ _eventSource: fakeSource(cliEvents) });
      const events = await collectEvents(adapter.run(makeInput("2+2")));
      const types = events.map((e) => e.type);
      expect(types).toContain("span.model_request_start");
      expect(types).toContain("span.model_request_end");
    });

    it("emits agent.message with correct text", async () => {
      const adapter = new CodexAdapter({ _eventSource: fakeSource(cliEvents) });
      const events = await collectEvents(adapter.run(makeInput("2+2")));
      const msg = events.find((e) => e.type === "agent.message") as AgentMessageEvent;
      expect(msg).toBeDefined();
      expect(msg.content[0]).toEqual({ type: "text", text: "Four." });
    });

    it("span.model_request_end contains usage", async () => {
      const adapter = new CodexAdapter({ _eventSource: fakeSource(cliEvents) });
      const events = await collectEvents(adapter.run(makeInput("2+2")));
      const end = events.find((e) => e.type === "span.model_request_end") as SpanModelRequestEndEvent;
      expect(end.usage.inputTokens).toBe(100);
      expect(end.usage.outputTokens).toBe(5);
    });
  });

  describe("tool use turn", () => {
    const cliEvents: CodexCliEvent[] = [
      { type: "thread.started", thread_id: "t1" },
      { type: "turn.started" },
      {
        type: "item.started",
        item: {
          id: "item_0",
          type: "command_execution",
          command: "ls",
          aggregated_output: "",
          exit_code: null,
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "item_0",
          type: "command_execution",
          command: "ls",
          aggregated_output: "file1.ts\nfile2.ts\n",
          exit_code: 0,
          status: "completed",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "item_1",
          type: "agent_message",
          text: "There are 2 files.",
        },
      },
      {
        type: "turn.completed",
        usage: { input_tokens: 200, output_tokens: 20 },
      },
    ];

    it("emits agent.tool_use for command_execution", async () => {
      const adapter = new CodexAdapter({ _eventSource: fakeSource(cliEvents) });
      const events = await collectEvents(adapter.run(makeInput("ls")));
      const toolUse = events.find((e) => e.type === "agent.tool_use") as AgentToolUseEvent;
      expect(toolUse).toBeDefined();
      expect(toolUse.name).toBe("shell");
      expect(toolUse.input).toEqual({ command: "ls" });
    });

    it("emits agent.tool_result with output", async () => {
      const adapter = new CodexAdapter({ _eventSource: fakeSource(cliEvents) });
      const events = await collectEvents(adapter.run(makeInput("ls")));
      const result = events.find((e) => e.type === "agent.tool_result") as AgentToolResultEvent;
      expect(result).toBeDefined();
      expect(result.content[0]).toEqual({ type: "text", text: "file1.ts\nfile2.ts\n" });
      expect(result.isError).toBe(false);
    });

    it("tool_result.toolUseId matches the item id", async () => {
      const adapter = new CodexAdapter({ _eventSource: fakeSource(cliEvents) });
      const events = await collectEvents(adapter.run(makeInput("ls")));
      const toolUse = events.find((e) => e.type === "agent.tool_use") as AgentToolUseEvent;
      const result = events.find((e) => e.type === "agent.tool_result") as AgentToolResultEvent;
      expect(result.toolUseId).toBe(toolUse.toolUseId);
    });

    it("marks non-zero exit code as error", async () => {
      const failEvents: CodexCliEvent[] = [
        { type: "thread.started", thread_id: "t1" },
        { type: "turn.started" },
        {
          type: "item.started",
          item: { id: "item_0", type: "command_execution", command: "false" },
        },
        {
          type: "item.completed",
          item: {
            id: "item_0",
            type: "command_execution",
            command: "false",
            aggregated_output: "",
            exit_code: 1,
            status: "completed",
          },
        },
        { type: "turn.completed", usage: { input_tokens: 50, output_tokens: 5 } },
      ];
      const adapter = new CodexAdapter({ _eventSource: fakeSource(failEvents) });
      const events = await collectEvents(adapter.run(makeInput("run false")));
      const result = events.find((e) => e.type === "agent.tool_result") as AgentToolResultEvent;
      expect(result.isError).toBe(true);
    });
  });

  describe("error handling", () => {
    it("emits session.error on turn.failed", async () => {
      const cliEvents: CodexCliEvent[] = [
        { type: "thread.started", thread_id: "t1" },
        { type: "turn.started" },
        { type: "turn.failed", error: { message: "API rate limited" } },
      ];
      const adapter = new CodexAdapter({ _eventSource: fakeSource(cliEvents) });
      const events = await collectEvents(adapter.run(makeInput("fail")));
      const last = events[events.length - 1] as any;
      expect(last.type).toBe("session.error");
      expect(last.error.message).toBe("API rate limited");
    });

    it("emits session.error on error event", async () => {
      const cliEvents: CodexCliEvent[] = [
        { type: "thread.started", thread_id: "t1" },
        { type: "error", message: "model not found" },
      ];
      const adapter = new CodexAdapter({ _eventSource: fakeSource(cliEvents) });
      const events = await collectEvents(adapter.run(makeInput("fail")));
      const last = events[events.length - 1] as any;
      expect(last.type).toBe("session.error");
      expect(last.error.message).toBe("model not found");
    });

    it("never throws from the async iterable", async () => {
      const adapter = new CodexAdapter({
        _eventSource: async function* () {
          throw new Error("unexpected crash");
        },
      });
      const events = await collectEvents(adapter.run(makeInput("crash")));
      const last = events[events.length - 1] as any;
      expect(last.type).toBe("session.error");
      expect(last.error.message).toBe("unexpected crash");
    });
  });

  describe("statelessness", () => {
    it("concurrent runs produce independent events", async () => {
      const cliEvents: CodexCliEvent[] = [
        { type: "thread.started", thread_id: "t1" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "i0", type: "agent_message", text: "ok" } },
        { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
      ];
      const adapter = new CodexAdapter({ _eventSource: fakeSource(cliEvents) });
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
      const adapter = new CodexAdapter({
        _eventSource: async function* (prompt: string) {
          seenPrompt = prompt;
          yield {
            type: "item.completed",
            item: { id: "i0", type: "agent_message", text: "ok" },
          } as CodexCliEvent;
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
  });
});
