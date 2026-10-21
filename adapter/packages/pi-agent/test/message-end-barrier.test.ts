import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { createAgentSession, defineTool, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Contract of the pinned SDK that a durable commit barrier relies on: an Agent
 * listener registered after AgentSession runs after the native append, Pi awaits
 * it before executing tools or requesting the model, and a sticky rejection stops
 * the operation without Pi's automatic retry.
 */
async function run(options: { fail?: "assistant" | "toolResult"; message?: string; sticky?: boolean } = {}) {
  const model = getModel("anthropic", "claude-sonnet-4-5")!;
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, compaction: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd: "/tmp", agentDir: "/tmp/oma-sdk-barrier-no-ambient", noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, settingsManager });
  await resourceLoader.reload();
  const sessionManager = SessionManager.inMemory("/tmp");
  const log: string[] = [];
  const probe = defineTool({
    name: "probe", label: "probe", description: "probe", parameters: Type.Object({ id: Type.String() }),
    async execute(_id, args) {
      log.push(`exec:start:${args.id}`);
      await sleep(10);
      log.push(`exec:end:${args.id}`);
      return { content: [{ type: "text" as const, text: `ok ${args.id}` }], details: {} };
    },
  });
  const { session } = await createAgentSession({ cwd: "/tmp", model, modelRuntime: await ModelRuntime.create({ allowModelNetwork: false }),
    resourceLoader, sessionManager, settingsManager, customTools: [probe], noTools: "builtin" });
  let requests = 0;
  session.agent.streamFunction = (_model, context) => {
    log.push(`request:${++requests}`);
    const toolTurn = !context.messages.some(message => message.role === "toolResult");
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      content: toolTurn
        ? [{ type: "toolCall", id: "a", name: "probe", arguments: { id: "a" } }, { type: "toolCall", id: "b", name: "probe", arguments: { id: "b" } }]
        : [{ type: "text", text: "done" }],
      stopReason: toolTurn ? "toolUse" : "stop" };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: toolTurn ? "toolUse" : "stop", message });
    return stream;
  };
  let failed = false;
  session.agent.subscribe(async event => {
    if (event.type !== "message_end") return;
    const role = event.message.role;
    const appended = sessionManager.getEntries().some(entry => entry.type === "message" && entry.message === event.message);
    log.push(`commit:${role}:${appended ? "appended" : "missing"}`);
    await sleep(30);
    const toolCalls = role === "assistant" && event.message.content.some(block => block.type === "toolCall");
    if ((failed && options.sticky) || (!failed && ((options.fail === "assistant" && toolCalls) || (options.fail === "toolResult" && role === "toolResult")))) {
      failed = true;
      log.push(`reject:${role}`);
      throw new Error(options.message ?? "oma_commit_barrier_failed");
    }
    log.push(`committed:${role}`);
  });
  let rejected: string | undefined;
  try { await session.prompt("go"); } catch (error) { rejected = error instanceof Error ? error.message : String(error); }
  const idle = session.isIdle;
  await session.dispose();
  return { log, requests, rejected, idle, executed: log.filter(item => item.startsWith("exec:start")).length };
}

describe("Agent message_end listener as a commit barrier (Pi 0.83.0)", () => {
  it("runs after the native append and is awaited before tools and the next request", async () => {
    const { log, requests, rejected } = await run();
    expect(rejected).toBeUndefined();
    expect(requests).toBe(2);
    expect(log.filter(item => item.startsWith("commit:"))).toEqual(
      ["commit:user:appended", "commit:assistant:appended", "commit:toolResult:appended", "commit:toolResult:appended", "commit:assistant:appended"]);
    const at = (item: string) => log.indexOf(item);
    expect(at("committed:assistant")).toBeLessThan(at("exec:start:a"));
    expect(log.lastIndexOf("committed:toolResult")).toBeLessThan(at("request:2"));
    // Parallel sibling execution is preserved behind one barrier.
    expect(at("exec:start:b")).toBeLessThan(at("exec:end:a"));
  });

  it("a sticky failure on the tool-calling assistant blocks every tool and request", async () => {
    const result = await run({ fail: "assistant", sticky: true });
    expect(result).toMatchObject({ executed: 0, requests: 1, rejected: "oma_commit_barrier_failed", idle: true });
  });

  it("a sticky failure on a tool result blocks the next model request", async () => {
    const result = await run({ fail: "toolResult", sticky: true, message: "Connection terminated unexpectedly" });
    expect(result).toMatchObject({ executed: 2, requests: 1, rejected: "Connection terminated unexpectedly", idle: true });
  });

  it("a one-shot failure with retryable text lets Pi retry past the barrier", async () => {
    // Pi turns listener errors into an error assistant message and applies its
    // provider retry policy to that text. Barrier failures must therefore stay
    // sticky; a fixed non-retryable message is defense in depth only.
    const result = await run({ fail: "toolResult", message: "Connection terminated unexpectedly" });
    expect(result).toMatchObject({ requests: 2, rejected: undefined });
  });
});
