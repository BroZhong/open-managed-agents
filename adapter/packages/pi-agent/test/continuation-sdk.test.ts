import { describe, expect, it } from "vitest";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { eventLogToAgentMessages } from "../src/event-log-to-messages.js";
import { installContinuation } from "../src/pi-continuation.js";
import { withGatewayErrors } from "../src/gateway-error-stream.js";
import type { SessionEvent } from "@open-managed-agents/adapter-core";

/** Exercise the pinned SDK's public continuation, including its retry layer. */
describe("structured SDK continuation", () => {
  it.each([
    { error: "503 overloaded", failures: 1, requests: 2, recovered: true },
    { error: "stream_read_error", failures: 1, requests: 2, recovered: true },
    { error: "upstream_error: Upstream service temporarily unavailable", failures: 1, requests: 2, recovered: true },
    { error: "stream_read_error", failures: 2, requests: 2, recovered: false },
    { error: "stream_read_error", failures: 1, requests: 1, recovered: false, retryEnabled: false },
    { error: '401: {"type":"invalid_authentication_error","message":"Invalid API key"}', failures: 1, requests: 1, recovered: false },
    { error: '429: {"code":"AccountQuotaExceeded","message":"You have exceeded the 5-hour usage quota."}', failures: 1, requests: 1, recovered: false },
  ])("preserves completed tools: $error ($failures failures, recovered=$recovered)", async (scenario) => {
    const model = getModel("anthropic", "claude-sonnet-4-5")!;
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: scenario.retryEnabled ?? true, maxRetries: 1, baseDelayMs: 1 }, compaction: { enabled: false } });
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
    session.agent.streamFunction = withGatewayErrors((_model, context) => {
      requests++;
      expect(context.messages.filter(m => m.role === "user")).toHaveLength(1);
      expect(context.messages.filter(m => m.role === "toolResult")).toHaveLength(1);
      const stream = createAssistantMessageEventStream();
      const failed = requests <= scenario.failures;
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "text", text: failed ? "" : "recovered" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: failed ? "error" : "stop", ...(failed ? { errorMessage: scenario.error } : {}), timestamp: Date.now() };
      stream.push({ type: "start", partial: message });
      if (failed) stream.push({ type: "error", reason: "error", error: message });
      else stream.push({ type: "done", reason: "stop", message });
      return stream;
    });
    try {
      await installContinuation(session)();
      expect(requests).toBe(scenario.requests);
      expect(session.messages.at(-1)).toMatchObject({
        role: "assistant", stopReason: scenario.recovered ? "stop" : "error",
        ...(scenario.recovered ? { content: [{ text: "recovered" }] } : { errorMessage: expect.stringContaining(scenario.error) }),
      });
      expect(session.isIdle).toBe(true);
      expect(sessionManager.getBranch().some(entry => entry.type === "custom_message" && entry.customType === "oma.continuation")).toBe(false);
      expect(session.messages.some(message => message.role === "custom" && message.customType === "oma.continuation")).toBe(false);
    } finally { await session.dispose(); }
  });
});
