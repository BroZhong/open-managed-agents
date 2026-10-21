import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEvent } from "@open-managed-agents/adapter-core";
import { MemoryTurnJournal } from "@open-managed-agents/adapter-core/testing";
import { PiAgentAdapter } from "../src/pi-agent-adapter.js";
import { restorePiSession } from "../src/pi-context.js";

/** The contexts of the model requests the resumed attempt makes; each is answered with "resumed". */
const control = vi.hoisted(() => ({ contexts: [] as Array<Pick<Context, "messages">> }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => {
  const sdk = await original<typeof import("@earendil-works/pi-coding-agent")>();
  class IsolatedLoader extends sdk.DefaultResourceLoader {
    constructor(options: ConstructorParameters<typeof sdk.DefaultResourceLoader>[0]) {
      super({ ...options, cwd: options.cwd ?? "/tmp", agentDir: "/tmp/oma-resume-shapes-no-ambient", noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true });
    }
  }
  return { ...sdk, DefaultResourceLoader: IsolatedLoader,
    async createAgentSession(options: Parameters<typeof sdk.createAgentSession>[0]) {
      const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
      const result = await sdk.createAgentSession({ ...options, settingsManager });
      result.session.agent.streamFunction = (model, context) => {
        control.contexts.push({ messages: JSON.parse(JSON.stringify(context.messages)) });
        const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          content: [{ type: "text", text: "resumed" }], stopReason: "stop" };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "start", partial: message });
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "resumed", partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: "resumed", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        return stream;
      };
      return result;
    },
  };
});

const model = getModel("anthropic", "claude-sonnet-4-5")!;
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"], timestamp: number): AssistantMessage =>
  ({ role: "assistant", api: model.api, provider: model.provider, model: model.id, usage, content, stopReason, timestamp,
    ...(stopReason === "error" ? { errorMessage: "503 overloaded" } : {}) });
const bash = (id: string) => ({ type: "toolCall" as const, id, name: "bash", arguments: { command: "sleep 600" } });

/** The Turn's committed native chain, as the Host replays it: the input, then `build`'s entries. */
function committed(build: (manager: SessionManager) => void): SessionEvent[] {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 });
  build(manager);
  return manager.getEntries().map((entry, index) => ({ id: `pi_entry_${entry.id}`, timestamp: entry.timestamp, type: "agent.context_entry",
    sdk: "pi@0.83.0", turnId: "turn", ...(index === 0 ? { inputEventId: "input" } : {}), entry })) as SessionEvent[];
}
/** The result the Host writes for a call a lost Runner left without one. */
const unknownResult = (toolUseId: string): SessionEvent => ({ id: `recovery_${toolUseId}`, timestamp: new Date(10).toISOString(),
  type: "agent.tool_result", toolUseId, isError: true, content: [{ type: "text", text: "outcome unknown" }] } as SessionEvent);

beforeEach(() => { vi.stubEnv("ANTHROPIC_API_KEY", "controlled-test-key"); control.contexts = []; });
afterEach(() => vi.unstubAllEnvs());

/** Continue the Turn from `history` and return what the attempt committed. */
async function resume(history: SessionEvent[]) {
  const journal = new MemoryTurnJournal();
  expect(await new PiAgentAdapter().run({ sessionId: "s", turnId: "turn", inputEventId: "input", history, journal,
    message: { role: "user", content: [{ type: "text", text: "go" }] }, agent: { model: `${model.provider}/${model.id}`, system: "" },
    resume: { completedModelSteps: 1, blockBase: 4 } })).toBe("finished");
  // The Host writes what the Adapter recorded last as it closes the attempt.
  await journal.flush();
  return journal.committed;
}

describe("Pi continues a resumed Turn from each shape its committed history can end in", () => {
  it.each([
    ["A5 the input itself", committed(() => {}), "user"],
    ["A9 a native tool result", committed((m) => {
      m.appendMessage(assistant([bash("call_1")], "toolUse", 2));
      m.appendMessage({ role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text: "done" }], isError: false, timestamp: 3 });
    }), "toolResult"],
    ["A6/A7 the unknown result the Host wrote for a dangling call", [...committed((m) => m.appendMessage(assistant([bash("call_1")], "toolUse", 2))),
      unknownResult("call_1")], "toolResult"],
    ["A8 a native result followed by the unknown result of its parallel call", [...committed((m) => {
      m.appendMessage(assistant([bash("call_1"), bash("call_2")], "toolUse", 2));
      m.appendMessage({ role: "toolResult", toolCallId: "call_2", toolName: "bash", content: [{ type: "text", text: "done" }], isError: false, timestamp: 3 });
    }), unknownResult("call_1")], "toolResult"],
    ["C9 steering applied at the request gate", committed((m) => {
      m.appendMessage(assistant([bash("call_1")], "toolUse", 2));
      m.appendMessage({ role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text: "done" }], isError: false, timestamp: 3 });
      m.appendCustomMessageEntry("subagent.instruction", [{ type: "text", text: "verify first" }], true, { instructionId: "cmd_1" });
    }), "user"],
    ["A11 a failed model request", committed((m) => m.appendMessage(assistant([{ type: "text", text: "" }], "error", 2))), "user"],
    ["A11 a request aborted while its call's arguments streamed", committed((m) => m.appendMessage(assistant([{ type: "text", text: "half" }, bash("call_1")], "aborted", 2))), "user"],
    ["B3 a compaction boundary after a failed request", committed((m) => {
      const first = m.getLeafId()!;
      m.appendMessage(assistant([{ type: "text", text: "" }], "error", 2));
      m.appendCompaction("earlier work", first, 900);
    }), "user"],
  ] as const)("%s", async (_shape, history, lastRole) => {
    const output = await resume([...history]);

    // One request, from the committed context with the input once; it ends
    // where the history does. Pi's providers leave out a failed or aborted
    // assistant message, so the request then ends at the message before it.
    expect(control.contexts).toHaveLength(1);
    const { messages } = control.contexts[0];
    const sent = messages.filter((message) => !(message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")));
    expect(sent.at(-1)?.role).toBe(lastRole);
    expect(JSON.stringify(messages).match(/"text":"go"/g)).toHaveLength(1);
    expect(output.filter((event) => event.type === "session.error")).toEqual([]);
    const answers = output.filter((event) => event.type === "agent.context_entry" && (event.entry as { message?: { role?: string } }).message?.role === "assistant");
    expect(answers.map((event) => event.type === "agent.context_entry" && event.presentation)).toEqual([{ version: 1, blocks: [{ type: "agent.message", index: 0, blockIndex: 4 }] }]);
    // The Turn's history, with what this attempt committed, replays as one chain ending in the answer.
    const replayed = restorePiSession([...history, ...output]).buildSessionContext().messages;
    expect(replayed.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "resumed" }] });
  });
});
