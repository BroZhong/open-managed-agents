import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AdapterInput, AgentToolResultEvent, SessionEvent, ToolExecutor } from "@open-managed-agents/adapter-core";
import { PiAgentAdapter, type PiSessionLike, type SessionFactoryArgs } from "../src/pi-agent-adapter.js";

function input(): AdapterInput { return { sessionId: "child", turnId: "turn", message: { role: "user", content: [{ type: "text", text: "task" }] }, history: [], agent: { model: "claude-sonnet-4-5", system: "test" } }; }
async function collect(adapter: PiAgentAdapter, value: AdapterInput) { const out: SessionEvent[] = []; for await (const e of adapter.run(value)) out.push(e); return out; }
function factory(run: (args: SessionFactoryArgs, emit: (e: AgentSessionEvent) => void) => Promise<void>, resume?: ReturnType<typeof vi.fn>) {
  return async (args: SessionFactoryArgs): Promise<PiSessionLike> => {
    let emit = (_e: AgentSessionEvent) => {};
    return { subscribe(fn) { emit = fn; return () => {}; }, prompt: () => run(args, emit), ...(resume ? { continue: async () => { resume(args); } } : {}), abort() {}, dispose() {} };
  };
}
const tool = (id: string): SessionEvent => ({ id: `use-${id}`, timestamp: "2026-01-01", type: "agent.tool_use", toolUseId: id, name: "Agent", input: { prompt: "child", run_in_background: false } });
const result = (id: string): AgentToolResultEvent => ({ id: `result-${id}`, timestamp: "2026-01-01", type: "agent.tool_result", toolUseId: id, content: [{ type: "text", text: "completed" }] });

describe("durable Pi execution seam", () => {
  it("exposes the current tool request in a checkpoint before the async event consumer persists it", async () => {
    let snapshot: SessionEvent[] = [];
    const adapter = new PiAgentAdapter({ _sessionFactory: factory(async (args, emit) => {
      emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, partial: { content: [] }, toolCall: { id: "wait-tool", name: "Agent", arguments: { prompt: "child" } } } } as unknown as AgentSessionEvent);
      snapshot = args.checkpoint();
    }) });
    const value = input(); value.history = [tool("old"), result("old")];
    const events = await collect(adapter, value);
    expect(snapshot.filter(e => e.type === "agent.tool_use")).toEqual(events.filter(e => e.type === "agent.tool_use"));
    expect(snapshot.some(e => (e as { toolUseId?: string }).toolUseId === "old")).toBe(false);
    expect(snapshot.find(e => e.type === "agent.tool_use")).toMatchObject({ toolUseId: "wait-tool" });
  });
  it("continues the original structured history exactly once without re-prompting or rerunning completed tools", async () => {
    const resume = vi.fn(); const prompt = vi.fn();
    const adapter = new PiAgentAdapter({ _sessionFactory: factory(prompt, resume) });
    const value = input(); value.history = [tool("done"), result("done"), tool("wait")]; value.continuation = { toolResults: [result("done"), result("wait")] };
    expect(await collect(adapter, value)).toEqual([]);
    expect(prompt).not.toHaveBeenCalled(); expect(resume).toHaveBeenCalledOnce();
    const history = resume.mock.calls[0][0].historyMessages;
    expect(history.filter((m: { role: string }) => m.role === "toolResult")).toHaveLength(2);
    expect(history.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "wait" });
  });
  it("refuses to continue while any original tool result remains pending", async () => {
    const resume = vi.fn(); const adapter = new PiAgentAdapter({ _sessionFactory: factory(vi.fn(), resume) });
    const value = input(); value.history = [tool("wait")]; value.continuation = { toolResults: [] };
    expect(await collect(adapter, value)).toMatchObject([{ type: "session.error", error: { message: expect.stringContaining("pending tool calls") } }]);
    expect(resume).not.toHaveBeenCalled();
  });
  it("counts model requests instead of OMA Turns and fails after the default 500 child steps", async () => {
    let requests = 0;
    const adapter = new PiAgentAdapter({ _sessionFactory: factory(async args => { for (;;) { await args.beforeModelStep(); requests++; } }) });
    const value = input(); value.execution = { isChild: true }; value.toolExecutor = {} as ToolExecutor;
    expect(await collect(adapter, value)).toMatchObject([{ type: "session.error", error: { code: "model_step_budget_exhausted" } }]);
    expect(requests).toBe(500);
  });
  it("retains the same Turn's consumed budget after recovery", async () => {
    let requests = 0;
    const adapter = new PiAgentAdapter({ _sessionFactory: factory(async args => { for (;;) { await args.beforeModelStep(); requests++; } }) });
    const value = input(); value.execution = { isChild: true, completedModelSteps: 499 }; value.toolExecutor = {} as ToolExecutor;
    await collect(adapter, value); expect(requests).toBe(1);
  });
  it.each(["executor", "mcp", "nested"])("fails closed when a child receives invalid %s capabilities", async mode => {
    const start = vi.fn(); const adapter = new PiAgentAdapter({ _sessionFactory: factory(start) });
    const value = input(); value.execution = { isChild: true };
    if (mode !== "executor") value.toolExecutor = {} as ToolExecutor;
    if (mode === "mcp") value.agent.mcpServers = [{ name: "web", url: "https://example.com" }];
    if (mode === "nested") value.subagents = {} as never;
    expect((await collect(adapter, value))[0]).toMatchObject({ type: "session.error" }); expect(start).not.toHaveBeenCalled();
  });
});

it("preserves interrupted tool argument bytes as an unexecuted failed call", async () => {
  const adapter = new PiAgentAdapter({ _sessionFactory: factory(async (_args, emit) => {
    const partial = { role: "assistant", content: [{ type: "toolCall", id: "partial-write", name: "write", arguments: {} }] };
    emit({ type: "message_start", message: { ...partial, model: "claude-sonnet-4-5", provider: "anthropic", api: "anthropic-messages" } } as unknown as AgentSessionEvent);
    emit({ type: "message_update", message: partial, assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial } } as unknown as AgentSessionEvent);
    emit({ type: "message_update", message: partial, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, partial, delta: '{"path":"unfinished' } } as unknown as AgentSessionEvent);
    emit({ type: "message_end", message: { ...partial, stopReason: "error", errorMessage: "stream_read_error" } } as unknown as AgentSessionEvent);
  }) });
  const events = await collect(adapter, input());
  expect(events.find(e => e.type === "agent.tool_use")).toMatchObject({ toolUseId: "partial-write", inputIncomplete: true, rawInput: '{"path":"unfinished' });
  expect(events.find(e => e.type === "agent.tool_result")).toMatchObject({ toolUseId: "partial-write", isError: true, content: [{ text: expect.stringContaining("not executed") }] });
  expect(events.at(-1)).toMatchObject({ type: "session.error", error: { message: "stream_read_error" } });
});

describe("effective execution configuration", () => {
  it("persists the resolved model and default thinking before constructing the session", async () => {
    let allowPersistence!: () => void;
    let persistenceStarted!: () => void;
    const persisted = new Promise<void>(resolve => { allowPersistence = resolve; });
    const started = new Promise<void>(resolve => { persistenceStarted = resolve; });
    const sessionFactory = vi.fn(factory(async () => {}));
    const onResolved = vi.fn(async () => { persistenceStarted(); await persisted; });
    const value = input(); value.execution = { onResolved };
    const events = collect(new PiAgentAdapter({ _sessionFactory: sessionFactory }), value);
    await started;
    expect(sessionFactory).not.toHaveBeenCalled();
    expect(onResolved).toHaveBeenCalledWith({ model: "anthropic/claude-sonnet-4-5", thinking: "high", thinkingSource: "model_default" });
    allowPersistence();
    expect(await events).toEqual([]);
    expect(sessionFactory).toHaveBeenCalledOnce();
  });
  it("records an explicit thinking override and does not execute when persistence loses its lease", async () => {
    const sessionFactory = vi.fn(factory(async () => {}));
    const onResolved = vi.fn(async () => { throw new Error("Execution lease lost"); });
    const value = input(); value.execution = { thinking: "low", onResolved };
    const events = await collect(new PiAgentAdapter({ _sessionFactory: sessionFactory }), value);
    expect(onResolved).toHaveBeenCalledWith({ model: "anthropic/claude-sonnet-4-5", thinking: "low", thinkingSource: "override" });
    expect(events).toMatchObject([{ type: "session.error", error: { message: "Execution lease lost" } }]);
    expect(sessionFactory).not.toHaveBeenCalled();
  });
});

describe("Agent thinking preference", () => {
  it.each([
    ["low", "low"],
    ["max", "high"],
    ["off", "off"],
  ] as const)("adapts %s to the model's supported %s level", async (requested, expected) => {
    const start = vi.fn(async (_args: SessionFactoryArgs) => {});
    const onResolved = vi.fn(async () => {});
    const value = input();
    value.agent.thinking = requested;
    value.execution = { onResolved };
    expect(await collect(new PiAgentAdapter({ _sessionFactory: factory(start) }), value)).toEqual([]);
    expect(start.mock.calls[0][0].thinkingLevel).toBe(expected);
    expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({ thinking: expected, thinkingSource: "agent" }));
  });
  it("keeps execution overrides authoritative over the Agent preference", async () => {
    const start = vi.fn(async (_args: SessionFactoryArgs) => {});
    const value = input(); value.agent.thinking = "max"; value.execution = { thinking: "low" };
    await collect(new PiAgentAdapter({ _sessionFactory: factory(start) }), value);
    expect(start.mock.calls[0][0].thinkingLevel).toBe("low");
  });
});
