import { describe, expect, it } from "vitest";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { eventLogToAgentMessages } from "../src/event-log-to-messages.js";
import type { SessionEvent } from "@open-managed-agents/adapter-core";

/** Exercise the pinned SDK's public continuation, including its retry layer. */
describe("structured SDK continuation", () => {
  it("retains an existing tool result and performs normal retry without adding another user prompt", async () => {
    const model = getModel("anthropic", "claude-sonnet-4-5")!;
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, compaction: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({ cwd: "/tmp", agentDir: "/tmp/oma-sdk-continuation-no-ambient", noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, settingsManager });
    await resourceLoader.reload();
    const sessionManager = SessionManager.inMemory("/tmp");
    const history = eventLogToAgentMessages([
      { type: "user.message", content: [{ type: "text", text: "delegate" }] },
      { type: "agent.tool_use", toolUseId: "original", name: "Agent", input: { prompt: "child" } },
      { type: "agent.tool_result", toolUseId: "original", content: [{ type: "text", text: "persisted child output" }] },
    ] as unknown as SessionEvent[]);
    for (const message of history) sessionManager.appendMessage(message);
    const { session } = await createAgentSession({ cwd: "/tmp", model, modelRuntime: await ModelRuntime.create({ allowModelNetwork: false }), resourceLoader, sessionManager, settingsManager, noTools: "all" });
    let requests = 0;
    session.agent.streamFn = (_model, context) => {
      requests++;
      expect(context.messages.filter(m => m.role === "user")).toHaveLength(1);
      expect(context.messages.filter(m => m.role === "toolResult")).toHaveLength(1);
      const stream = createAssistantMessageEventStream();
      const failed = requests === 1;
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "text", text: failed ? "" : "recovered" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: failed ? "error" : "stop", ...(failed ? { errorMessage: "503 overloaded" } : {}), timestamp: Date.now() };
      stream.push({ type: "start", partial: message });
      if (failed) stream.push({ type: "error", reason: "error", error: message });
      else stream.push({ type: "done", reason: "stop", message });
      return stream;
    };
    try {
      await session.continue();
      expect(requests).toBe(2);
      expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop", content: [{ text: "recovered" }] });
      expect(session.isIdle).toBe(true);
    } finally { await session.dispose(); }
  });
});
