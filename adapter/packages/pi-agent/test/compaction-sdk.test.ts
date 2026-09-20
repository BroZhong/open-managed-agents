import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import type { AdapterInput, SessionEvent } from "@open-managed-agents/adapter-core";
import { createLocalToolExecutor } from "@open-managed-agents/adapter-tool-executor-local";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { PiAgentAdapter } from "../src/pi-agent-adapter.js";
import { restorePiSession } from "../src/pi-context.js";

const control = vi.hoisted(() => ({ requests: [] as { summary: boolean; context: unknown; options: unknown }[], summaryFailures: 0, overflow: 0, summaryError: "503 overloaded", cancelSummary: false, toolPending: false, pauseSummary: false, onSummary: undefined as (() => void) | undefined }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => {
  const sdk = await original<typeof import("@earendil-works/pi-coding-agent")>();
  class IsolatedLoader extends sdk.DefaultResourceLoader {
    constructor(options: ConstructorParameters<typeof sdk.DefaultResourceLoader>[0]) {
      super({ ...options, cwd: options.cwd ?? "/tmp", agentDir: "/tmp/oma-compaction-no-ambient", noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true });
    }
  }
  return { ...sdk, DefaultResourceLoader: IsolatedLoader,
    async createAgentSession(options: Parameters<typeof sdk.createAgentSession>[0]) {
      const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 30 }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
      const result = await sdk.createAgentSession({ ...options, model: { ...options!.model!, contextWindow: 1000 }, settingsManager });
      result.session.agent.streamFunction = async (model, context, options) => {
        // Model responses arrive after request dispatch. Avoid same-millisecond
        // compaction/message timestamps changing the native stale-usage branch.
        await new Promise(resolve => setTimeout(resolve, 2));
        const summary = context.systemPrompt?.startsWith("You are a context summarization assistant") ?? false;
        control.requests.push({ summary, context: JSON.parse(JSON.stringify(context)), options: { reasoning: options?.reasoning, maxTokens: options?.maxTokens, cacheRetention: options?.cacheRetention } });
        const failed = summary ? control.summaryFailures-- > 0 : control.overflow-- > 0;
        const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: [{ type: "text", text: failed ? "" : summary ? "CONTROLLED SUMMARY" : "answer" }],
          usage: { input: 10, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 13, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: summary && control.cancelSummary ? "aborted" : failed ? "error" : "stop",
          ...(failed ? { errorMessage: summary ? control.summaryError : "prompt is too long: context window exceeded" } : {}), timestamp: Date.now() };
        if (!summary && !failed && control.toolPending) {
          control.toolPending = false;
          message.content = [{ type: "toolCall", id: "tool-1", name: "ls", arguments: { path: "." } }];
          message.stopReason = "toolUse";
        }
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "start", partial: message });
        if (summary && control.pauseSummary) {
          const cancel = () => stream.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted" } });
          if (options?.signal?.aborted) cancel();
          else options?.signal?.addEventListener("abort", cancel, { once: true });
          control.onSummary?.();
          return stream;
        }
        if (message.stopReason === "error" || message.stopReason === "aborted") stream.push({ type: "error", reason: message.stopReason, error: message });
        else stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
        return stream;
      };
      return result;
    },
  };
});
const model = getModel("anthropic", "claude-sonnet-4-5")!;
function seed(highUsage = true) {
  const manager = SessionManager.inMemory();
  for (let i = 0; i < 4; i++) {
    manager.appendMessage({ role: "user", content: `old ${i} ` + "history ".repeat(100), timestamp: i * 2 + 1 });
    manager.appendMessage({ role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "text", text: `old answer ${i}` }],
      usage: { input: highUsage ? 930 : 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: highUsage ? 935 : 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: i * 2 + 2 });
  }
  return manager;
}
function records(manager: SessionManager): SessionEvent[] {
  return manager.getEntries().map(entry => ({ id: `pi_entry_${entry.id}`, timestamp: entry.timestamp, type: "agent.context_entry", sdk: "pi@0.83.0", turnId: "seed", entry }));
}
function input(history: SessionEvent[], persistContext: AdapterInput["persistContext"]): AdapterInput {
  return { sessionId: "parent", turnId: "turn1", inputEventId: "input1", message: { role: "user", content: [{ type: "text", text: "continue" }] }, agent: { model: `${model.provider}/${model.id}`, system: "" }, history, persistContext };
}
async function run(input: AdapterInput) {
  const events: SessionEvent[] = [];
  for await (const event of new PiAgentAdapter().run(input)) events.push({ ...event, turnId: input.turnId } as SessionEvent);
  return events;
}
const normalize = (value: unknown) => JSON.parse(JSON.stringify(value, (key, v) => key === "timestamp" ? undefined : v));
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => { vi.stubEnv("ANTHROPIC_API_KEY", "controlled-test-key"); control.requests = []; control.summaryFailures = 0; control.overflow = 0; control.cancelSummary = false; control.toolPending = false; control.pauseSummary = false; control.onSummary = undefined; control.summaryError = "503 overloaded"; });

describe("Pi 0.83.0 native/platform compaction contract", () => {
  it("commits each new boundary when the native extension reports an older entry with equal summary text", async () => {
    const history = records(seed());
    const first = await run(input(history, async () => {}));
    const manager = restorePiSession([...history, ...first]);
    for (const entry of seed().getEntries()) {
      if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) manager.appendMessage({ ...entry.message, timestamp: Date.now() + 1000 });
    }
    const replay = records(manager);
    const second = await run({ ...input(replay, async () => {}), turnId: "second", inputEventId: "second" });
    expect(second.filter(event => event.type === "session.error")).toEqual([]);
    const restored = restorePiSession([...replay, ...second]);
    const summaries = restored.getEntries().filter(entry => entry.type === "compaction");
    expect(summaries).toHaveLength(2);
    expect(summaries[0].summary).toBe(summaries[1].summary);
    expect(summaries[0].id).not.toBe(summaries[1].id);
  });
  it("matches native threshold requests and restores committed context across later Turns", async () => {
    const original = seed();
    const history = records(original);
    const loader = new DefaultResourceLoader({ cwd: "/tmp", agentDir: "/tmp/oma-compaction-no-ambient", noContextFiles: true }); await loader.reload();
    const { session } = await createAgentSession({ model, thinkingLevel: "high", modelRuntime: await ModelRuntime.create({ allowModelNetwork: false }), sessionManager: original, resourceLoader: loader });
    let nativeAtCommit: unknown;
    session.subscribe(event => { if (event.type === "compaction_end" && event.result) nativeAtCommit = structuredClone(session.messages); });
    await session.prompt("continue");
    const nativeRequests = structuredClone(control.requests);
    const nativeMessages = structuredClone(session.messages);
    await session.dispose();
    control.requests = [];
    const committed: SessionEvent[] = [];
    const events = await run(input(history, async batch => { committed.push(...batch); }));
    expect(events.filter(e => e.type === "session.error")).toEqual([]);
    expect(control.requests.map(r => r.summary)).toEqual([true, false]);
    // Resource-loader prompts contain per-Host paths; compare summary request in
    // full and normal model messages, which are the context recovery contract.
    expect(normalize(control.requests[0])).toEqual(normalize(nativeRequests[0]));
    expect(normalize((control.requests[1].context as Context).messages)).toEqual(normalize((nativeRequests[1].context as Context).messages));
    expect(committed.some(e => e.type === "agent.context_entry" && (e.entry as {type: string}).type === "compaction")).toBe(true);
    const serialized = JSON.stringify([...history, ...events]);
    const fresh = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      'import {restorePiSession} from "./src/pi-context.ts"; let data=""; for await (const chunk of process.stdin) data+=chunk; process.stdout.write(JSON.stringify(restorePiSession(JSON.parse(data)).buildSessionContext().messages));'],
      { cwd: fileURLToPath(new URL("../", import.meta.url)), input: JSON.stringify([...history, { id: "input1", type: "user.message", content: [{type: "text", text: "continue"}] }, ...committed]), encoding: "utf8", timeout: 10000 });
    expect(fresh.status, fresh.stderr).toBe(0);
    expect(normalize(JSON.parse(fresh.stdout))).toEqual(normalize(nativeAtCommit));
    const restored = restorePiSession(JSON.parse(serialized));
    expect(normalize(restored.buildSessionContext().messages)).toEqual(normalize(nativeMessages));
    control.requests = [];
    const next = await run({ ...input([...history, ...events], async () => {}), turnId: "turn2", inputEventId: "input2" });
    expect(next.some(e => e.type === "agent.compaction")).toBe(false);
    expect(control.requests.map(r => r.summary)).toEqual([false]);
    expect(JSON.stringify(control.requests)).toContain("CONTROLLED SUMMARY");
  }, 15000);

  it.each([false, true])("stops before any request using an uncommitted summary (overflow=%s)", async overflow => {
    if (overflow) control.overflow = 1;
    const events = await run(input(records(seed(!overflow)), async () => { throw new Error("context storage unavailable"); }));
    expect(events.find(e => e.type === "session.error")).toMatchObject({ error: { message: expect.stringContaining("context storage unavailable") } });
    expect(events.some(e => e.type === "agent.context_entry" && (e.entry as {type: string}).type === "compaction")).toBe(false);
    expect(control.requests.map(r => r.summary)).toEqual(overflow ? [false, true] : [true]);
  });
  it.each([
    { name: "summary retry", failures: 1, overflow: 0, error: "503 overloaded", cancelled: false },
    { name: "summary retry exhausted", failures: 2, overflow: 0, error: "503 overloaded", cancelled: false },
    { name: "permanent summary error", failures: 1, overflow: 0, error: "401 invalid api key", cancelled: false },
    { name: "cancelled summary", failures: 0, overflow: 0, error: "", cancelled: true },
    { name: "overflow recovery", failures: 0, overflow: 1, error: "", cancelled: false },
    { name: "overflow recovery exhausted", failures: 0, overflow: 2, error: "", cancelled: false },
  ])("matches native request order and summary options: $name", async scenario => {
    const original = seed(scenario.overflow === 0);
    const history = records(original);
    const reset = () => { control.requests = []; control.summaryFailures = scenario.failures; control.overflow = scenario.overflow; control.summaryError = scenario.error; control.cancelSummary = scenario.cancelled; };
    reset();
    const loader = new DefaultResourceLoader({ cwd: "/tmp", agentDir: "/tmp/oma-compaction-no-ambient" }); await loader.reload();
    const { session } = await createAgentSession({ model, thinkingLevel: "high", modelRuntime: await ModelRuntime.create({ allowModelNetwork: false }), sessionManager: original, resourceLoader: loader });
    const ends: unknown[] = [];
    session.subscribe(event => { if (event.type === "compaction_end") ends.push({ reason: event.reason, aborted: event.aborted, success: !!event.result, willRetry: event.willRetry }); });
    await session.prompt("continue");
    const baseline = structuredClone(control.requests);
    await session.dispose();
    reset();
    const events = await run(input(history, async () => {}));
    expect(control.requests.map(r => r.summary)).toEqual(baseline.map(r => r.summary));
    expect(normalize(control.requests.filter(r => r.summary))).toEqual(normalize(baseline.filter(r => r.summary)));
    const statuses = events.filter(e => e.type === "agent.compaction" && ["completed", "failed", "cancelled"].includes(e.status));
    expect(statuses.map(e => e.type === "agent.compaction" && ({ reason: e.reason, aborted: e.status === "cancelled", success: e.status === "completed", willRetry: e.willRetry }))).toEqual(ends);
    if (scenario.failures === 1 && scenario.error.startsWith("503")) expect(events.some(e => e.type === "agent.compaction" && e.status === "retrying")).toBe(true);
  });

  it("restores Child Session tools and steering on resume, with isolated parent context and a model switch", async () => {
    const { executor, dispose } = await createLocalToolExecutor();
    let delivered = false;
    const applied = vi.fn(async () => {});
    const child = { ...input(records(seed()), async () => {}), sessionId: "child", toolExecutor: executor,
      message: { role: "user" as const, source: "delegation" as const, content: [{ type: "text" as const, text: "child task" }] },
      execution: { isChild: true, steering: { takePending: async () => delivered ? [] : (delivered = true, [{ id: "instruction1", message: "verify result" }]), applied } } };
    try {
      control.toolPending = true;
      const events = await run(child);
      expect(events.filter(e => e.type === "session.error")).toEqual([]);
      expect(applied).toHaveBeenCalledWith("instruction1");
      const history = [...child.history, ...events,
        { id: "instruction1", type: "subagent.instruction", instructionId: "instruction1", text: "verify result" } as unknown as SessionEvent];
      const messages = restorePiSession(history).buildSessionContext().messages;
      expect(messages.filter(m => m.role === "toolResult")).toHaveLength(1);
      expect(messages.filter(m => m.role === "custom")).toHaveLength(1);
      control.requests = [];
      const resumed = await run({ ...child, turnId: "resume", inputEventId: "resume-input", history,
        agent: { ...child.agent, model: "anthropic/claude-opus-4-1" }, execution: { isChild: true } });
      expect(resumed.filter(e => e.type === "session.error")).toEqual([]);
      expect(control.requests.map(r => r.summary)).toEqual([false]);
      const request = control.requests[0].context as Context;
      expect(request.messages.filter(m => m.role === "toolResult")).toHaveLength(1);
      expect(JSON.stringify(request.messages).match(/verify result/g)).toHaveLength(1);
      expect(JSON.stringify(request.messages)).toContain("CONTROLLED SUMMARY");
      control.requests = [];
      await run(input([], async () => {}));
      expect(JSON.stringify(control.requests)).not.toContain("CONTROLLED SUMMARY");
      expect(JSON.stringify(control.requests)).not.toContain("verify result");
    } finally { await dispose(); }
  });

  it("continues with steering without a synthetic compaction boundary or broken replay chain", async () => {
    const history = records(seed(false));
    let delivered = false;
    const events = await run({ ...input(history, async () => {}), continuation: { toolResults: [] },
      execution: { isChild: true, steering: { takePending: async () => delivered ? [] : (delivered = true, [{ id: "continue-steer", message: "verify continuation" }]), applied: async () => {} } } });
    expect(events.filter(e => e.type === "session.error")).toEqual([]);
    const restored = restorePiSession([...history, ...events]);
    expect(restored.getBranch().some(entry => entry.type === "custom_message" && entry.customType === "oma.continuation")).toBe(false);
    expect(JSON.stringify(restored.buildSessionContext().messages)).toContain("verify continuation");
    for (const entry of seed().getEntries()) {
      if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) restored.appendMessage({ ...entry.message, timestamp: Date.now() + 1000 });
    }
    control.requests = [];
    const replay = records(restored);
    const next = await run({ ...input(replay, async () => {}), turnId: "after-continuation", inputEventId: "next" });
    expect(next.filter(e => e.type === "session.error")).toEqual([]);
    expect(control.requests.some(r => r.summary)).toBe(true);
    expect(JSON.stringify(control.requests)).not.toContain("oma.continuation");
    expect(() => restorePiSession([...replay, ...next])).not.toThrow();
  });

  it("continues a recovered synchronous Delegation from its committed summary without another input", async () => {
    const manager = seed(false);
    const kept = manager.getEntries()[6].id;
    manager.appendCompaction("RECOVERED SUMMARY", kept, 935);
    manager.appendMessage({ role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: [{ type: "toolCall", id: "waiting-tool", name: "Agent", arguments: { prompt: "child task" } }],
      usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 25, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() });
    const history = [...records(manager),
      { id: "display-call", type: "agent.tool_use", turnId: "seed", toolUseId: "waiting-tool", name: "Agent", input: { prompt: "child task" } },
      { id: "recovered-result", type: "agent.tool_result", toolUseId: "waiting-tool", name: "Agent", content: [{ type: "text", text: "durable child result" }], timestamp: new Date().toISOString() },
    ] as SessionEvent[];
    const events = await run({ ...input(history, async () => {}), continuation: { toolResults: [] } });
    expect(events.filter(e => e.type === "session.error")).toEqual([]);
    expect(control.requests.map(r => r.summary)).toEqual([false]);
    const messages = (control.requests[0].context as Context).messages;
    expect(JSON.stringify(messages)).toContain("RECOVERED SUMMARY");
    expect(messages.filter(m => m.role === "toolResult")).toHaveLength(1);
    expect(JSON.stringify(messages)).not.toContain('"continue"');
    expect(JSON.stringify(messages)).not.toContain("old 0");
    expect(restorePiSession([...history, ...events]).buildSessionContext().messages.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "answer" }] });
  });

  it("remains recoverable when pre-prompt compaction fails before the promoted input becomes a native user message", async () => {
    const history = records(seed());
    const failed = await run(input(history, async () => { throw new Error("storage unavailable"); }));
    const promoted = { id: "input1", type: "user.message", content: [{ type: "text", text: "continue" }] } as unknown as SessionEvent;
    const next = await run({ ...input([...history, promoted, ...failed], async () => {}), turnId: "next", inputEventId: "next-input" });
    expect(next.filter(e => e.type === "session.error")).toEqual([]);
    const nativeUsers = restorePiSession([...history, promoted, ...failed, ...next]).buildSessionContext().messages.filter(m => m.role === "user" && JSON.stringify(m.content).includes('"continue"'));
    expect(nativeUsers).toHaveLength(1);
  });

  it("cancels a running native summary without committing a replay boundary", async () => {
    const controller = new AbortController();
    control.pauseSummary = true;
    control.onSummary = () => controller.abort();
    const persist = vi.fn(async () => {});
    const history = records(seed());
    const events = await run({ ...input(history, persist), signal: controller.signal });
    expect(persist).not.toHaveBeenCalled();
    expect(control.requests.map(r => r.summary)).toEqual([true]);
    expect(events.some(e => e.type === "agent.compaction" && e.status === "cancelled")).toBe(true);
    expect(restorePiSession([...history, ...events]).getEntries().some(e => e.type === "compaction")).toBe(false);
  });

  it("makes no model or summary request when interrupted before prompting", async () => {
    const controller = new AbortController(); controller.abort();
    const persist = vi.fn(async () => {});
    await run({ ...input(records(seed()), persist), signal: controller.signal });
    expect(control.requests).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
  });

  it.each(["before_compaction", "after_compaction"])("recovers only the persisted prefix when the Host exits %s", async boundary => {
    const history = records(seed());
    const saved: SessionEvent[] = [];
    await run(input(history, async batch => {
      saved.push(...(boundary === "before_compaction" ? batch.slice(0, -1) : batch));
      throw new Error("Host exited before acknowledging persistence");
    }));
    const promoted = { id: "input1", type: "user.message", content: [{ type: "text", text: "continue" }] } as unknown as SessionEvent;
    const durableHistory = JSON.parse(JSON.stringify([...history, promoted, ...saved]));
    const restored = restorePiSession(durableHistory);
    expect(restored.getEntries().filter(e => e.type === "compaction")).toHaveLength(boundary === "after_compaction" ? 1 : 0);
    control.requests = [];
    const next = await run({ ...input(durableHistory, async () => {}), turnId: "recovery", inputEventId: "recovery-input" });
    expect(next.filter(e => e.type === "session.error")).toEqual([]);
    expect(control.requests.map(r => r.summary)).toEqual(boundary === "after_compaction" ? [false] : [true, false]);
  });

});
