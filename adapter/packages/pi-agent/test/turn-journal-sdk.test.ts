import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AdapterInput, SessionEvent, ToolExecutor } from "@open-managed-agents/adapter-core";
import { createLocalToolExecutor } from "@open-managed-agents/adapter-tool-executor-local";
import { PiAgentAdapter } from "../src/pi-agent-adapter.js";
import { restorePiSession } from "../src/pi-context.js";
import { MemoryTurnJournal, type DurableEvent, type InputWithoutJournal } from "@open-managed-agents/adapter-core/testing";

type Content = AssistantMessage["content"];
/**
 * One scripted model response; `events` defaults to streaming each block in
 * order. A held response ends only when its request is aborted.
 */
interface Response { content: Content; stopReason: "stop" | "toolUse"; events?: (message: AssistantMessage) => AssistantMessageEvent[]; hold?: boolean }

const control = vi.hoisted(() => ({ log: [] as string[], responses: [] as Response[], onRequest: undefined as (() => void) | undefined, failStartup: false }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => {
  const sdk = await original<typeof import("@earendil-works/pi-coding-agent")>();
  class IsolatedLoader extends sdk.DefaultResourceLoader {
    constructor(options: ConstructorParameters<typeof sdk.DefaultResourceLoader>[0]) {
      super({ ...options, cwd: options.cwd ?? "/tmp", agentDir: "/tmp/oma-turn-journal-no-ambient", noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true });
    }
  }
  return { ...sdk, DefaultResourceLoader: IsolatedLoader,
    async createAgentSession(options: Parameters<typeof sdk.createAgentSession>[0]) {
      if (control.failStartup) throw new Error("Pi session startup failed");
      const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
      const result = await sdk.createAgentSession({ ...options, settingsManager });
      result.session.agent.streamFunction = (model, _context, options) => {
        control.log.push("request");
        control.onRequest?.();
        const response = control.responses.shift();
        if (!response) throw new Error("No scripted response left");
        const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          content: response.content, stopReason: response.stopReason };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "start", partial: message });
        for (const event of (response.events ?? streamed)(message)) stream.push(event);
        if (response.hold) options?.signal?.addEventListener("abort", () => stream.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted" } }), { once: true });
        else stream.push({ type: "done", reason: response.stopReason, message });
        return stream;
      };
      return result;
    },
  };
});

/** Provider stream events for every block, one block after another. */
function streamed(partial: AssistantMessage): AssistantMessageEvent[] {
  return partial.content.flatMap((block, contentIndex): AssistantMessageEvent[] => block.type === "text"
    ? [{ type: "text_start", contentIndex, partial }, { type: "text_delta", contentIndex, delta: block.text, partial }, { type: "text_end", contentIndex, content: block.text, partial }]
    : block.type === "thinking"
      ? [{ type: "thinking_start", contentIndex, partial }, { type: "thinking_delta", contentIndex, delta: block.thinking, partial }, { type: "thinking_end", contentIndex, content: block.thinking, partial }]
      : [{ type: "toolcall_start", contentIndex, partial }, { type: "toolcall_delta", contentIndex, delta: JSON.stringify(block.arguments), partial }, { type: "toolcall_end", contentIndex, toolCall: block, partial }]);
}

const model = getModel("anthropic", "claude-sonnet-4-5")!;
const ls = { type: "toolCall" as const, id: "ls-1", name: "ls", arguments: { path: "." } };
const toolThenAnswer = (): Response[] => [{ content: [ls], stopReason: "toolUse" }, { content: [{ type: "text", text: "listed" }], stopReason: "stop" }];
const role = (event: SessionEvent) => event.type === "agent.context_entry" ? (event.entry as { message?: { role?: string } }).message?.role : undefined;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => { vi.unstubAllEnvs(); await dispose?.(); dispose = undefined; });
beforeEach(() => { vi.stubEnv("ANTHROPIC_API_KEY", "controlled-test-key"); control.log = []; control.responses = []; control.onRequest = undefined; control.failStartup = false; });

/** Run one attempt through `journal`; in PR-A every run that settles has finished. */
async function run(journal: MemoryTurnJournal, extra: Partial<AdapterInput> = {}) {
  const local = await createLocalToolExecutor();
  dispose = local.dispose;
  const executor: ToolExecutor = Object.assign(Object.create(local.executor), {
    exec(command: string[], options?: Parameters<ToolExecutor["exec"]>[1]) { control.log.push("tool"); return local.executor.exec(command, options); },
  });
  const value: InputWithoutJournal = { sessionId: "s", turnId: "turn", inputEventId: "input", history: [], toolExecutor: executor,
    message: { role: "user", content: [{ type: "text", text: "list" }] }, agent: { model: `${model.provider}/${model.id}`, system: "" }, ...extra };
  expect(await new PiAgentAdapter().run({ ...value, journal })).toBe("finished");
  return journal.events;
}

/** A journal whose writes take a while, logging each batch's native roles once it is durable. */
function slowJournal(fail?: (batch: DurableEvent[]) => Error | undefined) {
  return new MemoryTurnJournal(async batch => {
    await sleep(20);
    const error = fail?.(batch);
    if (error) throw error;
    control.log.push(`commit:${batch.map(role).filter(Boolean).join(",")}`);
  });
}

describe("PiAgentAdapter with an injected Turn journal", () => {
  it("makes the tool request durable before the tool runs and its result before the next request", async () => {
    control.responses = toolThenAnswer();
    const journal = slowJournal();
    await run(journal);
    expect(journal.recorded.filter(event => event.type === "session.error")).toEqual([]);
    const commits = control.log.filter(item => item.startsWith("commit:") && item !== "commit:");
    expect(commits).toEqual(["commit:user", "commit:assistant", "commit:toolResult", "commit:assistant"]);
    const at = (item: string, from = 0) => control.log.indexOf(item, from);
    expect(at("commit:user")).toBeLessThan(at("request"));
    expect(at("commit:assistant")).toBeLessThan(at("tool"));
    expect(at("commit:toolResult")).toBeLessThan(at("request", at("request") + 1));
    // Each event is recorded once; the journal is the only path it takes.
    expect(new Set(journal.recorded.map(event => event.id)).size).toBe(journal.recorded.length);
  });

  it("makes steering applied at the request gate durable before that request", async () => {
    control.responses = [{ content: [{ type: "text", text: "steered" }], stopReason: "stop" }];
    let delivered = false;
    const journal = new MemoryTurnJournal(async batch => {
      await sleep(20);
      if (batch.some(event => event.type === "agent.context_entry" && (event.entry as { type: string }).type === "custom_message")) control.log.push("commit:instruction");
    });
    const takePending = async () => delivered ? [] : (delivered = true, [{ id: "instruction1", message: "verify first" }]);
    await run(journal, { execution: { steering: { takePending, applied: async () => {} } } });
    expect(control.log.filter(item => item === "commit:instruction" || item === "request")).toEqual(["commit:instruction", "request"]);
  });

  // A Resumed Turn runs with the model and thinking its first attempt ran with (#253).
  it.each([
    ["the model's default thinking", {}, "high"],
    ["the Agent's thinking preference, adapted to the model", { agent: { model: `${model.provider}/${model.id}`, system: "", thinking: "max" as const } }, "high"],
    ["an execution's thinking override", { execution: { thinking: "low" } }, "low"],
  ])("claims the input with the Turn's effective model and %s, durable before the first request", async (_name, extra, thinking) => {
    control.responses = [{ content: [{ type: "text", text: "listed" }], stopReason: "stop" }];
    const journal = slowJournal();
    await run(journal, extra);
    const [start] = journal.committed.filter(event => event.type === "agent.context_start");
    expect(start).toMatchObject({ turnId: "turn", inputEventId: "input", model: "anthropic/claude-sonnet-4-5", thinking });
    expect(journal.committed.indexOf(start)).toBeLessThan(journal.committed.findIndex(event => role(event) === "user"));
    expect(control.log.indexOf("commit:user")).toBeLessThan(control.log.indexOf("request"));
  });

  it("runs no tool and sends no request after a failed flush, and ends with the original failure", async () => {
    control.responses = toolThenAnswer();
    const journal = slowJournal(batch => batch.some(event => role(event) === "assistant") ? new Error("pending claim lease lost") : undefined);
    await run(journal);
    expect(control.log).not.toContain("tool");
    expect(control.log.filter(item => item === "request")).toHaveLength(1);
    expect(journal.committed.some(event => role(event) === "assistant")).toBe(false);
    expect(journal.recorded.filter(event => event.type === "session.error")).toMatchObject([{ error: { message: "pending claim lease lost", code: "pi_agent_error" } }]);
  });

  it("leaves the input to later Turns when the session fails to start", async () => {
    control.failStartup = true;
    const journal = new MemoryTurnJournal();
    await run(journal);
    expect(journal.recorded).toMatchObject([{ type: "session.error", error: { message: "Pi session startup failed" } }]);
    // The Host writes what was recorded; the input must stay replayable.
    const promoted = { id: "input", type: "user.message", content: [{ type: "text", text: "list" }] } as unknown as SessionEvent;
    expect(restorePiSession([promoted, ...journal.recorded]).buildSessionContext().messages)
      .toMatchObject([{ role: "user", content: [{ type: "text", text: "list" }] }]);
  });

  it("commits the output an Interrupt cut short and records no error for the Interrupt", async () => {
    const controller = new AbortController();
    control.onRequest = () => setTimeout(() => controller.abort(), 20);
    control.responses = [{ content: [{ type: "text", text: "half" }], stopReason: "stop", hold: true,
      events: partial => [{ type: "text_start", contentIndex: 0, partial }, { type: "text_delta", contentIndex: 0, delta: "half", partial }] }];
    const journal = new MemoryTurnJournal();
    await run(journal, { signal: controller.signal });
    expect(journal.deltas.map(({ event, blockIndex }) => [event.type, blockIndex])).toEqual([["agent.message_stream_start", 0], ["agent.message_chunk", 0]]);
    const assistant = journal.committed.find(event => role(event) === "assistant");
    expect(assistant).toMatchObject({ entry: { message: { stopReason: "aborted", content: [{ type: "text", text: "half" }] } },
      presentation: { version: 1, blocks: [{ type: "agent.message", index: 0, blockIndex: 0 }] } });
    expect(journal.committed.some(event => event.type === "span.model_request_end")).toBe(true);
    expect(journal.recorded.filter(event => event.type === "session.error")).toEqual([]);
  });
});

const presentations = (journal: MemoryTurnJournal, entryRole: string) => journal.recorded
  .filter(event => role(event) === entryRole)
  .map(event => event.type === "agent.context_entry" ? event.presentation?.blocks : undefined);
const deltas = (journal: MemoryTurnJournal) => journal.deltas
  .map(({ event, blockIndex }) => ({ type: event.type, blockIndex, ...("toolUseId" in event ? { toolUseId: event.toolUseId } : {}) }));

describe("Delta and Complete Event alignment through the journal", () => {
  it("numbers thinking, text, tool and MCP blocks of a new Turn from 0, including interleaved argument streams", async () => {
    const mcp = { type: "toolCall" as const, id: "mcp-1", name: "mcp", arguments: { tool: "web_search", args: '{"q":"oma"}', server: "web" } };
    control.responses = [
      { content: [{ type: "thinking", thinking: "plan" }, { type: "text", text: "calling" }, ls, mcp], stopReason: "toolUse",
        events: partial => [
          ...streamed({ ...partial, content: partial.content.slice(0, 2) }),
          { type: "toolcall_start", contentIndex: 2, partial }, { type: "toolcall_start", contentIndex: 3, partial },
          { type: "toolcall_delta", contentIndex: 3, delta: JSON.stringify(mcp.arguments), partial },
          { type: "toolcall_delta", contentIndex: 2, delta: JSON.stringify(ls.arguments), partial },
          { type: "toolcall_end", contentIndex: 2, toolCall: ls, partial }, { type: "toolcall_end", contentIndex: 3, toolCall: mcp, partial },
        ] },
      { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ];
    const journal = new MemoryTurnJournal();
    await run(journal, { agent: { model: `${model.provider}/${model.id}`, system: "", mcpServers: [{ name: "web", url: "https://mcp.example.invalid" }] } });
    expect(deltas(journal)).toEqual([
      { type: "agent.thinking_stream_start", blockIndex: 0 }, { type: "agent.thinking_chunk", blockIndex: 0 }, { type: "agent.thinking_stream_end", blockIndex: 0 },
      { type: "agent.message_stream_start", blockIndex: 1 }, { type: "agent.message_chunk", blockIndex: 1 }, { type: "agent.message_stream_end", blockIndex: 1 },
      { type: "agent.tool_use_input_stream_start", blockIndex: 2, toolUseId: "ls-1" }, { type: "agent.tool_use_input_stream_start", blockIndex: 3, toolUseId: "mcp-1" },
      { type: "agent.tool_use_input_chunk", blockIndex: 3, toolUseId: "mcp-1" }, { type: "agent.tool_use_input_chunk", blockIndex: 2, toolUseId: "ls-1" },
      { type: "agent.tool_use_input_stream_end", blockIndex: 2, toolUseId: "ls-1" }, { type: "agent.tool_use_input_stream_end", blockIndex: 3, toolUseId: "mcp-1" },
      { type: "agent.message_stream_start", blockIndex: 4 }, { type: "agent.message_chunk", blockIndex: 4 }, { type: "agent.message_stream_end", blockIndex: 4 },
    ]);
    expect(presentations(journal, "assistant")).toEqual([
      [{ type: "agent.thinking", index: 0, blockIndex: 0 }, { type: "agent.message", index: 1, blockIndex: 1 },
        { type: "agent.tool_use", index: 2, blockIndex: 2 }, { type: "agent.mcp_tool_use", index: 3, name: "search", serverName: "web", blockIndex: 3 }],
      [{ type: "agent.message", index: 0, blockIndex: 4 }],
    ]);
    // Results replace no stream block.
    expect(presentations(journal, "toolResult")).toEqual([[{ type: "agent.tool_result" }], [{ type: "agent.mcp_tool_result", serverName: "web" }]]);
  });

  it("leaves unstreamed blocks unnumbered and gives an unfinished stream's block its own index", async () => {
    control.responses = [
      { content: [ls], stopReason: "toolUse", events: () => [] },
      // The provider never closes the thinking stream before the text block.
      { content: [{ type: "thinking", thinking: "plan" }, { type: "text", text: "listed" }], stopReason: "stop",
        events: partial => [{ type: "thinking_start", contentIndex: 0, partial }, { type: "thinking_delta", contentIndex: 0, delta: "plan", partial },
          ...streamed({ ...partial, content: partial.content.slice(1) }).map(event => ({ ...event, contentIndex: 1 }))] },
    ];
    const journal = new MemoryTurnJournal();
    await run(journal);
    expect(deltas(journal)).toEqual([
      { type: "agent.thinking_stream_start", blockIndex: 0 }, { type: "agent.thinking_chunk", blockIndex: 0 },
      { type: "agent.message_stream_start", blockIndex: 1 }, { type: "agent.message_chunk", blockIndex: 1 }, { type: "agent.message_stream_end", blockIndex: 1 },
    ]);
    expect(presentations(journal, "assistant")).toEqual([
      [{ type: "agent.tool_use", index: 0 }],
      [{ type: "agent.thinking", index: 0, blockIndex: 0 }, { type: "agent.message", index: 1, blockIndex: 1 }],
    ]);
  });

  it("continues a resumed delegation wait after the blocks the Turn already committed", async () => {
    const seed = SessionManager.inMemory();
    seed.appendMessage({ role: "user", content: "delegate", timestamp: 1 });
    seed.appendMessage({ role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 2, stopReason: "toolUse",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      content: [{ type: "toolCall", id: "waiting-tool", name: "Agent", arguments: { prompt: "child task" } }] });
    const history = [
      ...seed.getEntries().map(entry => ({ id: `pi_entry_${entry.id}`, timestamp: entry.timestamp, type: "agent.context_entry", sdk: "pi@0.83.0", turnId: "turn", entry })),
      { id: "recovered-result", type: "agent.tool_result", toolUseId: "waiting-tool", name: "Agent", content: [{ type: "text", text: "durable child result" }], timestamp: new Date().toISOString() },
    ] as SessionEvent[];
    control.responses = [{ content: [{ type: "text", text: "resumed" }], stopReason: "stop" }];
    const journal = new MemoryTurnJournal();
    await run(journal, { history, resume: { completedModelSteps: 1, blockBase: 3 } });
    expect(journal.recorded.filter(event => event.type === "session.error")).toEqual([]);
    expect(deltas(journal)).toEqual([
      { type: "agent.message_stream_start", blockIndex: 3 }, { type: "agent.message_chunk", blockIndex: 3 }, { type: "agent.message_stream_end", blockIndex: 3 },
    ]);
    expect(presentations(journal, "assistant")).toEqual([[{ type: "agent.message", index: 0, blockIndex: 3 }]]);
  });

  it("rejects a resume blockBase that is not a non-negative integer", async () => {
    const journal = new MemoryTurnJournal();
    await run(journal, { resume: { completedModelSteps: 0, blockBase: -1 } });
    expect(control.log).toEqual([]);
    expect(journal.recorded).toMatchObject([{ type: "session.error", error: { message: "resume.blockBase must be a non-negative integer" } }]);
  });
});
