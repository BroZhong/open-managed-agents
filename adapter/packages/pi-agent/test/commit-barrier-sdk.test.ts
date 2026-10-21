import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, isContextOverflow, isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import type { AdapterInput, HostSubagentCapability, SessionEvent, ToolExecutor } from "@open-managed-agents/adapter-core";
import { createLocalToolExecutor } from "@open-managed-agents/adapter-tool-executor-local";
import { PiAgentAdapter } from "../src/pi-agent-adapter.js";
import { COMMIT_BARRIER_FAILED } from "../src/pi-context-journal.js";

const control = vi.hoisted(() => ({ log: [] as string[], toolCall: { id: "ls-1", name: "ls", arguments: { path: "." } as Record<string, unknown> } }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => {
  const sdk = await original<typeof import("@earendil-works/pi-coding-agent")>();
  class IsolatedLoader extends sdk.DefaultResourceLoader {
    constructor(options: ConstructorParameters<typeof sdk.DefaultResourceLoader>[0]) {
      super({ ...options, cwd: options.cwd ?? "/tmp", agentDir: "/tmp/oma-commit-barrier-no-ambient", noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true });
    }
  }
  return { ...sdk, DefaultResourceLoader: IsolatedLoader,
    async createAgentSession(options: Parameters<typeof sdk.createAgentSession>[0]) {
      const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
      const result = await sdk.createAgentSession({ ...options, settingsManager });
      result.session.agent.streamFunction = (model, context) => {
        control.log.push("request");
        const toolTurn = !context.messages.some(message => message.role === "toolResult");
        const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          content: toolTurn ? [{ type: "toolCall", ...control.toolCall }] : [{ type: "text", text: "listed" }],
          stopReason: toolTurn ? "toolUse" : "stop" };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: toolTurn ? "toolUse" : "stop", message });
        return stream;
      };
      return result;
    },
  };
});

const model = getModel("anthropic", "claude-sonnet-4-5")!;
const role = (event: SessionEvent) => event.type === "agent.context_entry" ? (event.entry as { message?: { role?: string } }).message?.role : undefined;
let dispose: (() => Promise<void>) | undefined;
afterEach(async () => { vi.unstubAllEnvs(); await dispose?.(); dispose = undefined; });
beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "controlled-test-key");
  control.log = [];
  control.toolCall = { id: "ls-1", name: "ls", arguments: { path: "." } };
});

async function run(persistContext: AdapterInput["persistContext"], extra: Partial<AdapterInput> = {}) {
  const local = await createLocalToolExecutor();
  dispose = local.dispose;
  const executor: ToolExecutor = Object.assign(Object.create(local.executor), {
    exec(command: string[], options?: Parameters<ToolExecutor["exec"]>[1]) { control.log.push("tool"); return local.executor.exec(command, options); },
  });
  const value: AdapterInput = { sessionId: "s", turnId: "turn", inputEventId: "input", history: [], toolExecutor: executor, persistContext,
    message: { role: "user", content: [{ type: "text", text: "list" }] }, agent: { model: `${model.provider}/${model.id}`, system: "" }, ...extra };
  const events: SessionEvent[] = [];
  for await (const event of new PiAgentAdapter().run(value)) events.push(event);
  return events;
}

describe("PiAgentAdapter commit barrier", () => {
  it("commits the tool request before the tool runs and its result before the next request", async () => {
    const events = await run(async batch => {
      control.log.push(`commit:${batch.map(role).filter(Boolean).join(",")}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    expect(events.filter(event => event.type === "session.error")).toEqual([]);
    const commits = control.log.filter(item => item.startsWith("commit:") && item !== "commit:");
    expect(commits).toEqual(["commit:user", "commit:assistant", "commit:toolResult", "commit:assistant"]);
    const at = (item: string, from = 0) => control.log.indexOf(item, from);
    expect(at("commit:user")).toBeLessThan(at("request"));
    expect(at("commit:assistant")).toBeLessThan(at("tool"));
    expect(at("commit:toolResult")).toBeLessThan(at("request", at("request") + 1));
  });

  it("starts a delegation only after its tool request is durable and hands the Host no history", async () => {
    control.toolCall = { id: "agent-1", name: "Agent", arguments: { prompt: "child" } };
    const committed: SessionEvent[] = [];
    let committedAtDelegation: SessionEvent[] = [];
    const delegate = vi.fn<HostSubagentCapability["delegate"]>(async () => {
      control.log.push("delegate");
      committedAtDelegation = [...committed];
      return { status: "completed", result: { output: "child done" } };
    });
    const subagents: HostSubagentCapability = { maxModelSteps: 500, delegate, getResult: vi.fn(), steer: vi.fn() };
    const events = await run(async batch => {
      committed.push(...batch);
      control.log.push(`commit:${batch.map(role).filter(Boolean).join(",")}`);
    }, { subagents });
    expect(events.filter(event => event.type === "session.error")).toEqual([]);
    expect(delegate).toHaveBeenCalledOnce();
    const [, context] = delegate.mock.calls[0];
    expect(Object.keys(context).sort()).toEqual(["signal", "toolUseId"]);
    expect(context.toolUseId).toBe("agent-1");
    expect(control.log.indexOf("commit:assistant")).toBeLessThan(control.log.indexOf("delegate"));
    const request = committedAtDelegation.find(event => role(event) === "assistant");
    expect(request).toMatchObject({ entry: { message: { content: [{ type: "toolCall", id: "agent-1", name: "Agent" }] } } });
  });

  it("stops before the tool and reports the original failure when a commit fails", async () => {
    const events = await run(async batch => {
      if (batch.some(event => role(event) === "assistant")) throw new Error("pending claim lease lost");
    });
    expect(control.log).not.toContain("tool");
    expect(control.log.filter(item => item === "request")).toHaveLength(1);
    expect(events.filter(event => event.type === "session.error")).toMatchObject([{ error: { message: "pending claim lease lost" } }]);
  });

  it("uses a rejection Pi neither retries nor treats as context overflow", () => {
    const message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, timestamp: 0, stopReason: "error", errorMessage: COMMIT_BARRIER_FAILED,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as AssistantMessage;
    expect(isRetryableAssistantError(message)).toBe(false);
    expect(isContextOverflow(message, model.contextWindow)).toBe(false);
  });
});
