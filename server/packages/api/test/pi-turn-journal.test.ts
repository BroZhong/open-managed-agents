import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMemoryStores } from "@oma-server/store-memory";
import { DefaultSandboxManager, FakeSandboxClient } from "@oma-server/sandbox";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { SessionRouter } from "@oma-server/session-router";
import { PendingEventClaimLostError, presentEvent } from "@oma-server/store";
import type { Adapter, AdapterInput, SessionEvent } from "@open-managed-agents/adapter-core";
import { PiAgentAdapter, registerCustomProvider, type CustomProviderDefinition } from "@open-managed-agents/adapter-pi-agent";

/** One Anthropic Messages response as server-sent events, streaming each block. */
type Block = { type: "thinking"; thinking: string } | { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: object };
function response(blocks: Block[], stopReason: "end_turn" | "tool_use"): Response {
  const events = [
    { type: "message_start", message: { id: "msg", type: "message", role: "assistant", content: [], model: "scripted-model", usage: { input_tokens: 1, output_tokens: 0 } } },
    ...blocks.flatMap((block, index) => [
      { type: "content_block_start", index, content_block: block.type === "tool_use" ? { ...block, input: {} } : block.type === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" } },
      ...(block.type === "thinking" ? [{ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } }, { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "signed" } }]
        : block.type === "text" ? [{ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } }]
          : [{ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }]),
      { type: "content_block_stop", index },
    ]),
    { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

/** The parent thinks, writes and delegates; the child answers; the resumed parent finishes. */
const model: typeof fetch = async (_url, init) => {
  const messages = JSON.stringify((JSON.parse(String(init?.body)) as { messages: unknown }).messages);
  if (messages.includes("<delegation>")) return response([{ type: "text", text: "child answer" }], "end_turn");
  if (messages.includes('"tool_result"')) return response([{ type: "text", text: "continued" }], "end_turn");
  return response([{ type: "thinking", thinking: "plan" }, { type: "text", text: "delegating" },
    { type: "tool_use", id: "wait-1", name: "Agent", input: { prompt: "child task" } }], "tool_use");
};
const provider: CustomProviderDefinition = { id: "scripted", name: "Scripted", api: "anthropic-messages", baseUrl: "https://model.example.invalid",
  apiKey: "controlled-test-key", models: [{ id: "scripted-model", name: "Scripted", contextWindow: 200000, maxTokens: 8192, input: ["text"] }] };

let agentDir: string;
beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "oma-pi-turn-journal-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(agentDir, { recursive: true, force: true }); });

it("writes each Pi event once through the Turn journal and keeps Deltas aligned across a resumed delegation wait", async () => {
  const pi = new PiAgentAdapter({ configureModelRuntime: (_input, runtime) => registerCustomProvider(runtime, provider, model) });
  const inputs: AdapterInput[] = [];
  const streamed: SessionEvent[] = [];
  const adapter: Adapter = { async *run(input) {
    inputs.push(input);
    for await (const event of pi.run(input)) { streamed.push(event); yield event; }
  } };
  const stores = createMemoryStores();
  const agent = await stores.agentStore.create({ tenantId: "tenant", name: "Pi", model: `${provider.id}/scripted-model`, system: "", runtime: "pi-agent", sandbox: { enabled: true } });
  const workspace = await stores.workspaceStore.create({ tenantId: "tenant" });
  const parent = await stores.sessionStore.create({ tenantId: "tenant", agentId: agent.id, agent, workspaceId: workspace.id });
  const hub = new InProcessEventStreamHub();
  const published: Array<{ sessionId: string; seq: number }> = [];
  const deltas: Array<{ sessionId: string; turnId?: string; blockIndex?: number; type: string }> = [];
  const publish = hub.publish.bind(hub);
  hub.publish = (sessionId, stored) => { published.push({ sessionId, seq: stored.seq }); publish(sessionId, stored); };
  const publishChunk = hub.publishChunk.bind(hub);
  hub.publishChunk = (sessionId, chunk) => { deltas.push({ sessionId, turnId: chunk.turnId, blockIndex: chunk.blockIndex, type: chunk.type }); publishChunk(sessionId, chunk); };
  const errors: unknown[] = [];
  const sandbox = new FakeSandboxClient();
  const makeRouter = () => new SessionRouter({ ...stores, eventStreamHub: hub, resolveAdapter: () => adapter,
    sandboxManager: new DefaultSandboxManager({ sandboxClient: sandbox, provisionSources: {} }),
    workspaceMount: { bucket: "agentry", agentName: "agentry-workspace", pvName: "agentry-workspace-oss", credentialProviderName: "agentry-oss-rw" },
    pendingClaimRetryMinMs: 10, pendingClaimRetryMaxMs: 20, onDrainError: ({ error }) => errors.push(error) });

  // The Runner is lost right after the delegation is accepted: its claim
  // lapses before it can wake the child or write anything else.
  const accept = stores.delegationStore.accept.bind(stores.delegationStore);
  vi.spyOn(stores.delegationStore, "accept").mockImplementationOnce(async (input, fence) => {
    await accept(input, fence);
    await stores.pendingEventStore.releaseClaim(parent.id, fence.eventId, fence);
    throw new PendingEventClaimLostError(parent.id, fence.eventId, fence.ownerId, fence.generation);
  });
  await stores.pendingEventStore.enqueue(parent.id, { type: "user.message", data: { content: [{ type: "text", text: "start" }] }, sessionThreadId: "sthr_primary" });
  await makeRouter().handleNewEvent(parent.id, agent);
  const replacement = makeRouter();
  await replacement.recoverPendingEvents();
  expect(await replacement.waitForIdle(20000)).toBe(true);
  expect(errors).toEqual([]);

  // Every Pi run wrote through its journal entry and streamed nothing.
  expect(streamed).toEqual([]);
  const parentRuns = inputs.filter(input => input.sessionId === parent.id);
  expect(parentRuns.map(input => [input.turnId, input.blockBase, typeof input.journal?.record])).toEqual([
    [parentRuns[0].turnId, 0, "function"], [parentRuns[0].turnId, 3, "function"]]);
  expect(inputs.filter(input => input.sessionId !== parent.id).map(input => input.blockBase)).toEqual([0]);

  const log = (await stores.eventLogStore.getEvents(parent.id, { limit: 1000 })).data;
  expect(log.filter(event => event.type === "session.error")).toEqual([]);
  expect(log.filter(event => event.type === "session.turn_completed")).toHaveLength(1);
  // Each event is one row, and each row Pi produced is published once. (A
  // later attempt's journal publishes its own idempotent hits again: the
  // promoted input and status_running.)
  const ids = log.map(event => (event.data as { id?: unknown }).id).filter(id => typeof id === "string");
  expect(new Set(ids).size).toBe(ids.length);
  const parentPublished = published.filter(item => item.sessionId === parent.id).map(item => item.seq);
  const piRows = log.filter(event => event.type.startsWith("agent.context_") || event.type.startsWith("span."));
  expect(piRows.map(event => event.type)).toEqual(expect.arrayContaining(["agent.context_start", "agent.context_entry", "agent.context_usage", "span.model_request_start", "span.model_request_end"]));
  expect(piRows.filter(event => parentPublished.filter(seq => seq === event.seq).length !== 1)).toEqual([]);
  // The lost attempt's failed delegation never became durable; the resumed
  // Turn received the child's recovered result once.
  const results = log.flatMap(event => presentEvent(event)).filter(event => event.type === "agent.tool_result");
  expect(results).toEqual([expect.objectContaining({ data: expect.objectContaining({ toolUseId: "wait-1", isError: false }) })]);
  expect(JSON.stringify(results[0].data)).toContain("child answer");

  // Deltas and the Complete Events that replace them share a blockIndex, and
  // the resumed attempt continues after the blocks the first one committed.
  const turnId = parentRuns[0].turnId;
  const blocks = (rows: typeof deltas) => [...new Set(rows.map(delta => `${delta.type.replace(/_(stream_start|stream_end|chunk|input_stream_start|input_chunk|input_stream_end)$/, "")}@${delta.blockIndex}`))];
  expect(blocks(deltas.filter(delta => delta.sessionId === parent.id && delta.turnId === turnId)))
    .toEqual(["agent.thinking@0", "agent.message@1", "agent.tool_use@2", "agent.message@3"]);
  const displays = log.flatMap(event => presentEvent(event))
    .filter(event => ["agent.thinking", "agent.message", "agent.tool_use"].includes(event.type))
    .map(event => ({ type: event.type, blockIndex: (event.data as { blockIndex?: number }).blockIndex, turnId: (event.data as { turnId?: string }).turnId }));
  expect(displays).toEqual([
    { type: "agent.thinking", blockIndex: 0, turnId }, { type: "agent.message", blockIndex: 1, turnId },
    { type: "agent.tool_use", blockIndex: 2, turnId }, { type: "agent.message", blockIndex: 3, turnId },
  ]);
}, 60000);
