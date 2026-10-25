import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMemoryStores } from "@oma-server/store-memory";
import { DefaultSandboxManager, DefaultTurnSandboxes, FakeSandboxClient, SandboxCreateRejected } from "@oma-server/sandbox";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { SessionRouter } from "@oma-server/session-router";
import { workspaceObjectPrefix, type StoredEvent } from "@oma-server/store";
import { PiAgentAdapter, registerCustomProvider, type CustomProviderDefinition } from "@open-managed-agents/adapter-pi-agent";

/**
 * Sandbox unavailability beside a real Pi Turn (ADR-0023, #287): a tool call
 * that meets one is a tool error whose native result carries `details.code`,
 * the model can retry, and the Turn ends with sandbox_unavailable because its
 * Sandbox never became ready again. The model's first request does not
 * wait for the Sandbox's connect. (A Turn that recovers records no error:
 * session-router's sandbox-unavailability tests.)
 */

/** One Anthropic Messages response as server-sent events. */
type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: object };
function response(blocks: Block[], stopReason: "end_turn" | "tool_use"): Response {
  const events = [
    { type: "message_start", message: { id: "msg", type: "message", role: "assistant", content: [], model: "scripted-model", usage: { input_tokens: 1, output_tokens: 0 } } },
    ...blocks.flatMap((block, index) => [
      { type: "content_block_start", index, content_block: block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" } },
      block.type === "text"
        ? { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } }
        : { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } },
      { type: "content_block_stop", index },
    ]),
    { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

const workspaceMount = { bucket: "agentry", agentName: "agentry-workspace", pvName: "agentry-workspace-oss", credentialProviderName: "agentry-oss-rw" };
const provider: CustomProviderDefinition = { id: "scripted", name: "Scripted", api: "anthropic-messages", baseUrl: "https://model.example.invalid",
  apiKey: "controlled-test-key", models: [{ id: "scripted-model", name: "Scripted", contextWindow: 200000, maxTokens: 8192, input: ["text"] }] };

let agentDir: string;
beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "oma-pi-sandbox-unavailability-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(agentDir, { recursive: true, force: true }); });

/** A Router running real Pi against `model`, over a fake gateway. */
async function setup(model: typeof fetch) {
  const pi = new PiAgentAdapter({ configureModelRuntime: (_input, runtime) => registerCustomProvider(runtime, provider, model) });
  const stores = createMemoryStores();
  const agent = await stores.agentStore.create({ tenantId: "tenant", name: "Pi", model: `${provider.id}/scripted-model`, system: "", runtime: "pi-agent", sandbox: { enabled: true } });
  const workspace = await stores.workspaceStore.create({ tenantId: "tenant" });
  const session = await stores.sessionStore.create({ tenantId: "tenant", agentId: agent.id, agent, workspaceId: workspace.id });
  const sandbox = new FakeSandboxClient();
  const manager = new DefaultSandboxManager({ sandboxClient: sandbox, environment: "test" });
  const errors: unknown[] = [];
  const router = new SessionRouter({ ...stores, eventStreamHub: new InProcessEventStreamHub(), resolveAdapter: () => pi,
    sandboxes: new DefaultTurnSandboxes({ manager, bindings: stores.delegationStore, sessions: stores.sessionStore, workspaceMount,
      onError: ({ error }) => errors.push(error) }),
    pendingClaimRetryMinMs: 10, pendingClaimRetryMaxMs: 20, onDrainError: ({ error }) => errors.push(error) });
  const send = async (text: string) => {
    await stores.pendingEventStore.enqueue(session.id, { type: "user.message", data: { content: [{ type: "text", text }] }, sessionThreadId: "sthr_primary" });
    await router.handleNewEvent(session.id, agent);
  };
  const log = async () => (await stores.eventLogStore.getEvents(session.id, { limit: 1000 })).data;
  return { stores, session, sandbox, manager, router, errors, send, log };
}

/** The native toolResult entries of `log`, as the model got them. */
const toolResults = (log: StoredEvent[]) => log.flatMap((stored) => {
  const message = stored.type === "agent.context_entry"
    ? (stored.data as { entry: { message?: { role?: string; toolCallId?: string; isError?: boolean; details?: Record<string, unknown> } } }).entry.message : undefined;
  return message?.role === "toolResult" ? [{ id: message.toolCallId, isError: message.isError, code: message.details?.code, reason: message.details?.reason }] : [];
});
const errorCodes = (log: StoredEvent[]) => log.filter((stored) => stored.type === "session.error")
  .map((stored) => (stored.data as { error: { code: string } }).error.code);

it("returns each tool call of a Pi Turn whose Sandbox is never available as a tool error with its code, and ends the Turn with one sandbox_unavailable", async () => {
  // The model retries the tool once it sees the error, then gives up.
  const requests: string[] = [];
  const model: typeof fetch = async (_url, init) => {
    requests.push(String(init?.body));
    return requests.length <= 2
      ? response([{ type: "tool_use", id: `bash-${requests.length}`, name: "bash", input: { command: "echo hi" } }], "tool_use")
      : response([{ type: "text", text: "The Sandbox is unavailable." }], "end_turn");
  };
  const h = await setup(model);
  h.sandbox.createFault = (step) => { if (step === "claim") throw new SandboxCreateRejected(403); };
  await h.send("run echo");
  expect(await h.router.waitForIdle(20000)).toBe(true);

  const log = await h.log();
  expect(toolResults(log)).toEqual([
    { id: "bash-1", isError: true, code: "sandbox_unavailable", reason: "rejected" },
    { id: "bash-2", isError: true, code: "sandbox_unavailable", reason: "rejected" },
  ]);
  // The model saw the error text, never the gateway's diagnostics.
  expect(requests[1]).toContain("The gateway rejected the Sandbox creation. A later tool call can retry.");
  expect(requests).toHaveLength(3);
  expect(errorCodes(log)).toEqual(["sandbox_unavailable"]);
  expect(log.map((stored) => stored.type).slice(-3)).toEqual(["session.error", "session.turn_completed", "session.status_idle"]);
  expect(log.filter((stored) => stored.type === "span.sandbox_prepare_end").map((stored) => stored.data))
    .toEqual([0, 1].map(() => expect.objectContaining({ outcome: "failed", code: "sandbox_unavailable", reason: "rejected" })));
  // The Session API reports it from the binding (#290).
  expect(await h.stores.delegationStore.sandbox(h.session.id))
    .toMatchObject({ state: "unavailable", lastError: { code: "sandbox_unavailable", reason: "rejected" } });
  expect(h.errors).toEqual([]);
}, 60000);

it("sends a Pi Turn's first model request before the Sandbox's connect returns", async () => {
  const events: string[] = [];
  const model: typeof fetch = async () => {
    events.push("model request");
    return response([{ type: "text", text: "hello" }], "end_turn");
  };
  const h = await setup(model);
  // The binding is Ready: a tool of an earlier Turn created its Sandbox.
  await h.manager.open({ tenantId: "tenant", workspaceId: h.session.workspaceId,
    workspaceMount: { ...workspaceMount, prefix: workspaceObjectPrefix("tenant", h.session.workspaceId) } },
  { id: h.session.id, withLock: (work) => h.stores.delegationStore.withBindingLock(h.session.id, work) }).writeFile("saved.txt", "kept");
  let connected!: () => void;
  const connecting = new Promise<void>((resolve) => { connected = resolve; });
  const reconnect = h.sandbox.reconnect.bind(h.sandbox);
  vi.spyOn(h.sandbox, "reconnect").mockImplementation(async (id, metadata) => {
    events.push("connecting");
    await connecting;
    events.push("connected");
    return reconnect(id, metadata);
  });
  await h.stores.pendingEventStore.enqueue(h.session.id, { type: "user.message", data: { content: [{ type: "text", text: "hello" }] }, sessionThreadId: "sthr_primary" });
  void h.router.handleNewEvent(h.session.id, h.session.agent);
  await vi.waitFor(() => expect(events).toContain("model request"), { timeout: 20000 });
  expect(events).toEqual(["connecting", "model request"]);
  connected();
  expect(await h.router.waitForIdle(20000)).toBe(true);
  expect(events).toEqual(["connecting", "model request", "connected"]);
  const log = await h.log();
  expect(errorCodes(log)).toEqual([]);
  expect(log.map((stored) => stored.type).slice(-2)).toEqual(["session.turn_completed", "session.status_idle"]);
  expect(h.errors).toEqual([]);
}, 60000);
