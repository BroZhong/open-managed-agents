import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { ToolEnvironmentError, type ToolExecutor } from "@open-managed-agents/adapter-core";
import { createLocalToolExecutor } from "@open-managed-agents/adapter-tool-executor-local";
import { MemoryTurnJournal, type DurableEvent } from "@open-managed-agents/adapter-core/testing";
import { PiAgentAdapter } from "../src/pi-agent-adapter.js";

/**
 * An environment failure of the executor reaches the model as a tool error
 * whose details carry its code (ADR-0023, #287), through the real Pi SDK: the
 * native toolResult entry the Turn journal records keeps them.
 */

type Content = AssistantMessage["content"];
const control = vi.hoisted(() => ({ responses: [] as Array<{ content: Content; stopReason: "stop" | "toolUse" }> }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => {
  const sdk = await original<typeof import("@earendil-works/pi-coding-agent")>();
  class IsolatedLoader extends sdk.DefaultResourceLoader {
    constructor(options: ConstructorParameters<typeof sdk.DefaultResourceLoader>[0]) {
      super({ ...options, cwd: options.cwd ?? "/tmp", agentDir: "/tmp/oma-environment-errors-no-ambient", noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true });
    }
  }
  return { ...sdk, DefaultResourceLoader: IsolatedLoader,
    async createAgentSession(options: Parameters<typeof sdk.createAgentSession>[0]) {
      const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
      const result = await sdk.createAgentSession({ ...options, settingsManager });
      result.session.agent.streamFunction = (model) => {
        const response = control.responses.shift();
        if (!response) throw new Error("No scripted response left");
        const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          content: response.content, stopReason: response.stopReason };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "start", partial: message });
        for (const event of streamed(message)) stream.push(event);
        stream.push({ type: "done", reason: response.stopReason, message });
        return stream;
      };
      return result;
    },
  };
});

function streamed(partial: AssistantMessage): AssistantMessageEvent[] {
  return partial.content.flatMap((block, contentIndex): AssistantMessageEvent[] => block.type === "text"
    ? [{ type: "text_start", contentIndex, partial }, { type: "text_delta", contentIndex, delta: block.text, partial }, { type: "text_end", contentIndex, content: block.text, partial }]
    : block.type === "toolCall"
      ? [{ type: "toolcall_start", contentIndex, partial }, { type: "toolcall_delta", contentIndex, delta: JSON.stringify(block.arguments), partial }, { type: "toolcall_end", contentIndex, toolCall: block, partial }]
      : []);
}

const model = getModel("anthropic", "claude-sonnet-4-5")!;
const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall" as const, id, name, arguments: args });
/** The native toolResult entries the journal recorded, by call. */
const toolResults = (events: DurableEvent[]) => events.flatMap((event) => {
  const message = event.type === "agent.context_entry" ? (event.entry as { message?: { role?: string; toolCallId?: string; isError?: boolean; details?: unknown } }).message : undefined;
  return message?.role === "toolResult" ? [{ id: message.toolCallId, isError: message.isError, details: message.details }] : [];
});

let dispose: (() => Promise<void>) | undefined;
beforeEach(() => { vi.stubEnv("ANTHROPIC_API_KEY", "controlled-test-key"); control.responses = []; });
afterEach(async () => { vi.unstubAllEnvs(); await dispose?.(); dispose = undefined; });

/** A local executor whose environment fails the first `failures` operations that start a tool. */
async function executor(failures: number): Promise<ToolExecutor> {
  const local = await createLocalToolExecutor();
  dispose = local.dispose;
  let failed = 0;
  const fileSystem = local.executor.fileSystem!;
  return Object.assign(Object.create(local.executor), {
    fileSystem: { ...fileSystem, createTempFile: async (options?: Parameters<typeof fileSystem.createTempFile>[0]) => {
      if (failed++ < failures) throw new ToolEnvironmentError("sandbox_unavailable", "The Session's Sandbox is not available right now.", { reason: "unknown" });
      return fileSystem.createTempFile(options);
    } },
  });
}

async function run(toolExecutor: ToolExecutor): Promise<DurableEvent[]> {
  const journal = new MemoryTurnJournal(async () => {});
  expect(await new PiAgentAdapter().run({ sessionId: "s", turnId: "turn", inputEventId: "input", history: [], toolExecutor, journal,
    message: { role: "user", content: [{ type: "text", text: "list" }] }, agent: { model: `${model.provider}/${model.id}`, system: "" } })).toBe("finished");
  return journal.committed;
}

describe("an environment failure of the executor", () => {
  it("is a tool error whose details carry its code, which the model retries", async () => {
    control.responses = [
      { content: [call("ls-1", "ls", { path: "." })], stopReason: "toolUse" },
      { content: [call("ls-2", "ls", { path: "." })], stopReason: "toolUse" },
      { content: [{ type: "text", text: "listed" }], stopReason: "stop" },
    ];
    const events = await run(await executor(1));
    const [failed, retried] = toolResults(events);
    expect(failed).toEqual({ id: "ls-1", isError: true, details: { code: "sandbox_unavailable", reason: "unknown" } });
    expect(retried).toMatchObject({ id: "ls-2", isError: false });
    expect(retried.details ?? {}).not.toHaveProperty("code");
    expect(events.filter((event) => event.type === "session.error")).toEqual([]);
  });

  it("leaves a tool's own failure without a code", async () => {
    control.responses = [
      { content: [call("read-1", "read", { path: "missing.txt" })], stopReason: "toolUse" },
      { content: [{ type: "text", text: "missing" }], stopReason: "stop" },
    ];
    const [result] = toolResults(await run(await executor(0)));
    expect(result).toMatchObject({ id: "read-1", isError: true });
    expect(result.details ?? {}).not.toHaveProperty("code");
  });
});
