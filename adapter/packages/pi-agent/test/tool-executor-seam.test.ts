import { describe, it, expect } from "vitest";
import { createLocalToolExecutor } from "@open-managed-agents/adapter-tool-executor-local";
import type {
  AdapterInput,
  SessionEvent,
  AgentToolResultEvent,
  ToolExecutor,
  ExecOptions,
  ExecOutputChunk,
  FileListEntry,
} from "@open-managed-agents/adapter-core";
import { PiAgentAdapter } from "../src/pi-agent-adapter.js";
import type { PiCliEvent } from "../src/cli-types.js";

function makeInput(
  prompt: string,
  toolExecutor?: ToolExecutor,
  sessionId = "seam-session",
): AdapterInput {
  return {
    sessionId,
    turnId: "t1",
    message: { role: "user", content: [{ type: "text", text: prompt }] },
    agent: { model: "pi-1", system: "You are helpful." },
    history: [],
    toolExecutor,
  };
}

async function collect(
  iterable: AsyncIterable<SessionEvent>,
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

// A Pi turn that asks to run a `write_file` tool, then a `read_file` tool.
// The CLI emits tool_execution_start (which our seam intercepts) AND a native
// tool_execution_end (which must be suppressed when routed).
function toolTurn(): PiCliEvent[] {
  return [
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
          id: "tc_write",
          name: "write_file",
          args: { path: "note.txt", content: "seam-ok" },
        },
      },
    },
    {
      type: "tool_execution_start",
      toolCallId: "tc_write",
      toolName: "write_file",
      args: { path: "note.txt", content: "seam-ok" },
    },
    // Native CLI end that must be dropped because we routed the call ourselves.
    {
      type: "tool_execution_end",
      toolCallId: "tc_write",
      toolName: "write_file",
      result: "CLI-SHOULD-NOT-WIN",
      isError: false,
    },
    {
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        toolCall: { id: "tc_read", name: "read_file", args: { path: "note.txt" } },
      },
    },
    {
      type: "tool_execution_start",
      toolCallId: "tc_read",
      toolName: "read_file",
      args: { path: "note.txt" },
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
}

describe("Pi adapter ToolExecutor seam", () => {
  it("runs a self-implemented file tool end-to-end through the seam", async () => {
    const { executor, dispose } = await createLocalToolExecutor();
    try {
      const adapter = new PiAgentAdapter({ _eventSource: fakeSource(toolTurn()) });
      const events = await collect(adapter.run(makeInput("write then read", executor)));

      const results = events.filter(
        (e) => e.type === "agent.tool_result",
      ) as AgentToolResultEvent[];
      expect(results).toHaveLength(2);

      // Write result came from the executor, not the CLI's native end.
      const writeText = (results[0].content[0] as { text: string }).text;
      expect(writeText).toContain("note.txt");
      expect(writeText).not.toContain("CLI-SHOULD-NOT-WIN");

      // Read result reflects what the write actually wrote to the temp dir.
      expect((results[1].content[0] as { text: string }).text).toBe("seam-ok");

      // And the file really exists on disk in the executor's own root.
      expect(await executor.readFile("note.txt")).toBe("seam-ok");
    } finally {
      await dispose();
    }
  });

  it("passes an exec tool call through to the executor", async () => {
    const { executor, dispose } = await createLocalToolExecutor();
    try {
      const cli: PiCliEvent[] = [
        {
          type: "message_start",
          message: { role: "assistant", content: [], model: "pi-1" },
        },
        {
          type: "tool_execution_start",
          toolCallId: "tc_sh",
          toolName: "shell",
          args: { command: "printf hi-from-exec" },
        },
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { total: 0 },
            },
          },
        },
      ];
      const adapter = new PiAgentAdapter({ _eventSource: fakeSource(cli) });
      const events = await collect(adapter.run(makeInput("run", executor)));
      const result = events.find(
        (e) => e.type === "agent.tool_result",
      ) as AgentToolResultEvent;
      expect((result.content[0] as { text: string }).text).toBe("hi-from-exec");
      expect(result.isError).toBe(false);
    } finally {
      await dispose();
    }
  });

  it("surfaces executor errors as an error tool_result (never aborts the run)", async () => {
    const { executor, dispose } = await createLocalToolExecutor();
    try {
      const cli: PiCliEvent[] = [
        {
          type: "message_start",
          message: { role: "assistant", content: [], model: "pi-1" },
        },
        {
          type: "tool_execution_start",
          toolCallId: "tc_miss",
          toolName: "read_file",
          args: { path: "does-not-exist.txt" },
        },
      ];
      const adapter = new PiAgentAdapter({ _eventSource: fakeSource(cli) });
      const events = await collect(adapter.run(makeInput("read missing", executor)));
      const result = events.find(
        (e) => e.type === "agent.tool_result",
      ) as AgentToolResultEvent;
      expect(result.isError).toBe(true);
      // The run still completed cleanly.
      expect(events[events.length - 1].type).toBe("session.status_idle");
    } finally {
      await dispose();
    }
  });

  it("without an injected executor, native CLI tool results flow unchanged", async () => {
    const cli: PiCliEvent[] = [
      {
        type: "message_start",
        message: { role: "assistant", content: [], model: "pi-1" },
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
        result: "native-result",
        isError: false,
      },
    ];
    const adapter = new PiAgentAdapter({ _eventSource: fakeSource(cli) });
    // No toolExecutor on the input.
    const events = await collect(adapter.run(makeInput("ls")));
    const result = events.find(
      (e) => e.type === "agent.tool_result",
    ) as AgentToolResultEvent;
    expect((result.content[0] as { text: string }).text).toBe("native-result");
  });

  it("concurrent runs use DISTINCT executors with zero cross-session bleed", async () => {
    // Each run gets its own executor, injected per-call. A tool call in run A
    // must only ever touch A's temp dir; run B must not see A's file, and vice
    // versa. This is the FastClaw shared-registry hazard we are avoiding.
    const a = await createLocalToolExecutor();
    const b = await createLocalToolExecutor();
    expect(a.executor.root).not.toBe(b.executor.root);

    // Track which executor received each exec, to prove no cross-wiring.
    const seenBy = new Map<ToolExecutor, string[]>();
    const wrap = (inner: ToolExecutor, tag: string): ToolExecutor => {
      seenBy.set(inner, []);
      return {
        exec(command: string[], opts?: ExecOptions): AsyncIterable<ExecOutputChunk> {
          seenBy.get(inner)!.push(command.join(" "));
          return inner.exec(command, opts);
        },
        readFile: (p: string) => inner.readFile(p),
        writeFile(p: string, c: string): Promise<void> {
          seenBy.get(inner)!.push(`write ${p}:${tag}`);
          return inner.writeFile(p, c);
        },
        list: (g?: string): Promise<FileListEntry[]> => inner.list(g),
      };
    };
    const execA = wrap(a.executor, "A");
    const execB = wrap(b.executor, "B");

    const runFor = (tag: string): PiCliEvent[] => [
      {
        type: "message_start",
        message: { role: "assistant", content: [], model: "pi-1" },
      },
      {
        type: "tool_execution_start",
        toolCallId: `tc_${tag}`,
        toolName: "write_file",
        args: { path: "shared-name.txt", content: `payload-${tag}` },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { total: 0 },
          },
        },
      },
    ];

    const adapter = new PiAgentAdapter({
      _eventSource: (_prompt, _opts) => {
        // Route the fake source by prompt so each concurrent run gets its turn.
        return (async function* () {
          const events = _prompt.includes("run-A")
            ? runFor("A")
            : runFor("B");
          for (const e of events) yield e;
        })();
      },
    });

    const [eventsA, eventsB] = await Promise.all([
      collect(adapter.run(makeInput("run-A", execA, "session-A"))),
      collect(adapter.run(makeInput("run-B", execB, "session-B"))),
    ]);

    // Both wrote the SAME filename; distinct executors keep them isolated.
    expect(await a.executor.readFile("shared-name.txt")).toBe("payload-A");
    expect(await b.executor.readFile("shared-name.txt")).toBe("payload-B");

    // Each executor only ever saw its own run's writes.
    expect(seenBy.get(a.executor)).toEqual(["write shared-name.txt:A"]);
    expect(seenBy.get(b.executor)).toEqual(["write shared-name.txt:B"]);

    // No event id overlap either.
    const idsA = new Set(eventsA.map((e) => e.id));
    const overlap = eventsB.map((e) => e.id).filter((id) => idsA.has(id));
    expect(overlap).toHaveLength(0);

    await a.dispose();
    await b.dispose();
  });
});
