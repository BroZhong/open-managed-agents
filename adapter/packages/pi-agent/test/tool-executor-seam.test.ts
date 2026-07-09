import { describe, it, expect } from "vitest";
import { createLocalToolExecutor } from "@open-managed-agents/adapter-tool-executor-local";
import type { AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
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
import type {
  PiSessionLike,
  SessionFactoryArgs,
} from "../src/pi-agent-adapter.js";
import { buildCustomTools } from "../src/custom-tools.js";

function makeInput(
  prompt: string,
  toolExecutor?: ToolExecutor,
  sessionId = "seam-session",
): AdapterInput {
  return {
    sessionId,
    turnId: "t1",
    message: { role: "user", content: [{ type: "text", text: prompt }] },
    agent: { model: "claude-sonnet-4-5", system: "You are helpful." },
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

/** A single scripted tool call the fake Pi runtime should make. */
interface ScriptedCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * Fake Pi session that mirrors how the real SDK drives custom tools:
 *  - It builds the adapter's custom tools from the injected ToolExecutor
 *    (exactly as the real createAgentSession path does via buildCustomTools).
 *  - On prompt(), for each scripted tool call it emits `toolcall_end`, invokes
 *    the matching custom tool's execute() (which proxies into the executor),
 *    then emits `tool_execution_end` carrying the real AgentToolResult.
 *
 * This exercises the full seam: model tool call -> custom tool -> ToolExecutor
 * -> AgentToolResult -> canonical agent.tool_result event.
 */
function toolDrivingFactory(calls: ScriptedCall[]) {
  return async (args: SessionFactoryArgs): Promise<PiSessionLike> => {
    const tools: ToolDefinition[] = args.input.toolExecutor
      ? buildCustomTools(args.input.toolExecutor)
      : [];
    const byName = new Map(tools.map((t) => [t.name, t]));
    let listener: ((e: AgentSessionEvent) => void) | undefined;

    return {
      subscribe(l) {
        listener = l;
        return () => {
          listener = undefined;
        };
      },
      async prompt() {
        listener?.({
          type: "message_start",
          message: { role: "assistant", model: "claude-sonnet-4-5" },
        } as never as AgentSessionEvent);

        for (const call of calls) {
          listener?.({
            type: "message_update",
            message: { role: "assistant" },
            assistantMessageEvent: {
              type: "toolcall_end",
              contentIndex: 0,
              toolCall: {
                type: "toolCall",
                id: call.id,
                name: call.name,
                arguments: call.args,
              },
            },
          } as never as AgentSessionEvent);

          const tool = byName.get(call.name);
          // Pi's native tools (which our factories build) throw on failure and
          // let Pi mark the result as an error; on success they return an
          // AgentToolResult. Mirror that here: a thrown error becomes an error
          // result carrying the message, matching how the real SDK renders it.
          let result: unknown = "no such tool";
          let isError = true;
          if (tool) {
            try {
              result = await tool.execute(
                call.id,
                call.args as never,
                undefined,
                undefined,
                {} as never,
              );
              isError = false;
            } catch (e: unknown) {
              result = {
                content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
              };
              isError = true;
            }
          }

          listener?.({
            type: "tool_execution_end",
            toolCallId: call.id,
            toolName: call.name,
            result,
            isError,
          } as never as AgentSessionEvent);
        }

        listener?.({
          type: "message_end",
          message: {
            role: "assistant",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { total: 0 },
            },
          },
        } as never as AgentSessionEvent);

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

describe("Pi adapter ToolExecutor seam (SDK custom tools)", () => {
  it("runs self-implemented file tools end-to-end through the seam", async () => {
    const { executor, dispose } = await createLocalToolExecutor();
    try {
      const adapter = new PiAgentAdapter({
        _sessionFactory: toolDrivingFactory([
          { id: "tc_write", name: "write", args: { path: "note.txt", content: "seam-ok" } },
          { id: "tc_read", name: "read", args: { path: "note.txt" } },
        ]),
      });
      const events = await collect(
        adapter.run(makeInput("write then read", executor)),
      );

      const results = events.filter(
        (e) => e.type === "agent.tool_result",
      ) as AgentToolResultEvent[];
      expect(results).toHaveLength(2);

      // Write result came from the executor.
      const writeText = (results[0].content[0] as { text: string }).text;
      expect(writeText).toContain("note.txt");

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
      const adapter = new PiAgentAdapter({
        _sessionFactory: toolDrivingFactory([
          { id: "tc_sh", name: "bash", args: { command: "printf hi-from-exec" } },
        ]),
      });
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
      const adapter = new PiAgentAdapter({
        _sessionFactory: toolDrivingFactory([
          { id: "tc_miss", name: "read", args: { path: "does-not-exist.txt" } },
        ]),
      });
      const events = await collect(
        adapter.run(makeInput("read missing", executor)),
      );
      const result = events.find(
        (e) => e.type === "agent.tool_result",
      ) as AgentToolResultEvent;
      expect(result.isError).toBe(true);
      // The run still completed cleanly: an executor error becomes an error
      // tool_result, not a session.error, and the adapter emits no lifecycle
      // events (the Host router owns those — issue #83).
      const types = events.map((e) => e.type);
      expect(types).not.toContain("session.error");
      expect(types).not.toContain("session.status_idle");
      expect(types).not.toContain("session.status_running");
    } finally {
      await dispose();
    }
  });

  it("without an injected executor, no custom tools are built (pi keeps its own)", async () => {
    let hadExecutor = true;
    let toolNames: string[] = [];
    const adapter = new PiAgentAdapter({
      _sessionFactory: async (args: SessionFactoryArgs): Promise<PiSessionLike> => {
        hadExecutor = args.hasToolExecutor;
        toolNames = args.input.toolExecutor
          ? buildCustomTools(args.input.toolExecutor).map((t) => t.name)
          : [];
        let listener: ((e: AgentSessionEvent) => void) | undefined;
        return {
          subscribe(l) {
            listener = l;
            return () => {};
          },
          async prompt() {
            listener?.({ type: "agent_end", messages: [], willRetry: false } as AgentSessionEvent);
          },
          abort() {},
          dispose() {},
        };
      },
    });
    // No toolExecutor on the input.
    await collect(adapter.run(makeInput("ls")));
    expect(hadExecutor).toBe(false);
    expect(toolNames).toEqual([]);
  });

  it("concurrent runs use DISTINCT executors with zero cross-session bleed", async () => {
    // Each run gets its own executor, injected per-call. A tool call in run A
    // must only ever touch A's temp dir; run B must not see A's file, and vice
    // versa. This is the FastClaw shared-registry hazard we are avoiding.
    const a = await createLocalToolExecutor();
    const b = await createLocalToolExecutor();
    expect(a.executor.root).not.toBe(b.executor.root);

    // Track which executor received each write, to prove no cross-wiring.
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

    const adapter = new PiAgentAdapter({
      _sessionFactory: (args: SessionFactoryArgs) => {
        const tag = args.prompt.includes("run-A") ? "A" : "B";
        return toolDrivingFactory([
          {
            id: `tc_${tag}`,
            name: "write",
            args: { path: "shared-name.txt", content: `payload-${tag}` },
          },
        ])(args);
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
