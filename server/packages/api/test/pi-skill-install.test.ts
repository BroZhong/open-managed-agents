import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMemoryStores } from "@oma-server/store-memory";
import { DefaultSandboxManager, DefaultTurnSandboxes, FakeSandboxClient, fakeEnvironments, FAKE_ENVIRONMENT_IMAGE } from "@oma-server/sandbox";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { SessionRouter } from "@oma-server/session-router";
import { presentEvent } from "@oma-server/store";
import { PiAgentAdapter, registerCustomProvider, type CustomProviderDefinition } from "@open-managed-agents/adapter-pi-agent";

/**
 * A Skill Install beside a real Pi Turn (ADR-0022, #268): the install that
 * the Turn's first tool call waits for fails, so that call does not run and
 * the Turn ends with skills_install_failed instead of the model retrying.
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

const provider: CustomProviderDefinition = { id: "scripted", name: "Scripted", api: "anthropic-messages", baseUrl: "https://model.example.invalid",
  apiKey: "controlled-test-key", models: [{ id: "scripted-model", name: "Scripted", contextWindow: 200000, maxTokens: 8192, input: ["text"] }] };

let agentDir: string;
beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "oma-pi-skill-install-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(agentDir, { recursive: true, force: true }); });

it("ends a Pi Turn whose first tool call finds the Skill Install failed: the call and the Turn end with skills_install_failed", async () => {
  // Every request asks to read a Skill: a model that saw the error would retry.
  const requests: string[] = [];
  const model: typeof fetch = async (_url, init) => {
    requests.push(String(init?.body));
    return response([{ type: "text", text: "reading the Skill" },
      { type: "tool_use", id: "read-1", name: "read", input: { path: "/skills/writer/SKILL.md" } }], "tool_use");
  };
  const pi = new PiAgentAdapter({ configureModelRuntime: (_input, runtime) => registerCustomProvider(runtime, provider, model) });
  const stores = createMemoryStores();
  const agent = await stores.agentStore.create({ tenantId: "tenant", name: "Pi", model: `${provider.id}/scripted-model`, system: "", runtime: "pi-agent", sandbox: { enabled: true }, environmentId: "env_test" });
  const workspace = await stores.workspaceStore.create({ tenantId: "tenant" });
  const session = await stores.sessionStore.create({ tenantId: "tenant", agentId: agent.id, agent, workspaceId: workspace.id });
  const sandbox = new FakeSandboxClient();
  // The new Sandbox's install of its (empty) Skill Set fails, its retry too.
  sandbox.skillInstallFault = (stage) => { if (stage === "switch") throw new Error("No space left on device"); };
  const errors: unknown[] = [];
  const router = new SessionRouter({ ...stores, eventStreamHub: new InProcessEventStreamHub(), resolveAdapter: () => pi,
    sandboxes: new DefaultTurnSandboxes({ environments: fakeEnvironments(), manager: new DefaultSandboxManager({ sandboxClient: sandbox, environment: "test" }),
      bindings: stores.delegationStore, sessions: stores.sessionStore,
      workspaceMount: { bucket: "agentry", agentName: "agentry-workspace", pvName: "agentry-workspace-oss", credentialProviderName: "agentry-oss-rw" },
      onError: ({ error }) => errors.push(error) }),
    pendingClaimRetryMinMs: 10, pendingClaimRetryMaxMs: 20, onDrainError: ({ error }) => errors.push(error) });

  await stores.pendingEventStore.enqueue(session.id, { type: "user.message", data: { content: [{ type: "text", text: "use the writer Skill" }] }, sessionThreadId: "sthr_primary" });
  await router.handleNewEvent(session.id, agent);
  expect(await router.waitForIdle(20000)).toBe(true);

  const log = (await stores.eventLogStore.getEvents(session.id, { limit: 1000 })).data;
  const message = "Skill Install failed at switch: No space left on device";
  expect(log.filter((event) => event.type === "session.error").map((event) => (event.data as { error: unknown }).error))
    .toEqual([{ code: "skills_install_failed", message }]);
  const results = log.flatMap((event) => presentEvent(event)).filter((event) => event.type === "agent.tool_result");
  expect(results.map((event) => event.data)).toEqual([expect.objectContaining({ toolUseId: "read-1", isError: true,
    content: [{ type: "text", text: `skills_install_failed: ${message}. The tool was not executed.` }] })]);
  expect(requests).toHaveLength(1);
  expect(log.filter((event) => event.type.startsWith("span.skills_install_")).map((event) => event.data)).toEqual([
    expect.objectContaining({ installId: expect.any(String), skills: 0 }),
    expect.objectContaining({ outcome: "failed", stage: "switch", reason: "No space left on device", durationMs: expect.any(Number) }),
  ]);
  expect(log.map((event) => event.type).slice(-3)).toEqual(["session.error", "session.turn_completed", "session.status_idle"]);
  expect((await stores.sessionStore.getById(session.id))?.status).toBe("idle");
  expect(await stores.delegationStore.installedSkillSet(session.id)).toBeNull();
  expect(errors).toEqual([]);
}, 60000);
