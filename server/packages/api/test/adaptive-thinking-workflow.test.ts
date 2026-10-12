import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createMemoryStores } from "@oma-server/store-memory";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { SessionRouter } from "@oma-server/session-router";
import { PiAgentAdapter } from "@open-managed-agents/adapter-pi-agent";
import { createApp } from "../src/app.js";
import { ModelProviderService } from "../src/lib/model-providers.js";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("carries all five saved Adaptive efforts through Session overrides into native Pi requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oma-adaptive-workflow-"));
  vi.stubEnv("AUTH_DISABLED", "true");
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  const modelId = "global.anthropic.claude-opus-5-5";
  const requests: { model: string; thinking: { type: string; budget_tokens?: number }; output_config: { effort: string } }[] = [];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe("https://gateway.example.com/v1/messages");
    requests.push(JSON.parse(String(init?.body)));
    const events = [
      { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], model: modelId, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }));
  const stores = createMemoryStores();
  const service = new ModelProviderService(stores.modelProviderStore, "ab".repeat(32));
  const adapter = new PiAgentAdapter({ configureModelRuntime: service.configureRuntime(stores.sessionStore) });
  const router = new SessionRouter({ ...stores, eventStreamHub: new InProcessEventStreamHub(), resolveAdapter: () => adapter });
  const app = createApp({ ...stores, modelProviderService: service,
    thinkingOptions: (tenant, model) => service.thinkingOptions(tenant, model, async () => { throw new Error("Unexpected managed lookup"); }),
  });
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = async (response: Response) => { const data = await response.json(); expect(response.ok, JSON.stringify(data)).toBe(true); return data; };
  try {
    const config = { name: "Opus Gateway", api: "anthropic-messages", baseUrl: "https://gateway.example.com", apiKey: "controlled-test-key", models: [{ id: modelId, name: "Opus", input: ["text"], contextWindow: 131072, maxTokens: 32768, thinkingProfile: "anthropic-adaptive" }] };
    const proof = await json(await post("/v1/model-providers/test", config));
    expect(requests[0].output_config.effort).toBe("max");
    const provider = await json(await post("/v1/model-providers", { ...config, verificationToken: proof.verificationToken }));
    expect(requests).toHaveLength(1);
    const model = `${provider.id}/${modelId}`;
    const options = await json(await app.request(`/v1/model-thinking-options?model=${encodeURIComponent(model)}`));
    expect(options.choices.map((choice: { value: string }) => choice.value)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    const agent = await json(await post("/v1/agents", { name: "Adaptive", model, runtime: "pi-agent", system: "Reply OK", sandbox: { enabled: false } }));
    const session = await json(await post("/v1/sessions", { agent: agent.id }));
    expect(await json(await app.request(`/v1/sessions/${session.id}/thinking-options`))).toEqual(options);
    for (const [preference, effort] of [["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "xhigh"], ["max", "max"], [null, "max"], ["off", "low"]] as const) {
      await json(await post(`/v1/sessions/${session.id}`, { thinking: preference }));
      const before = requests.length;
      await json(await post(`/v1/sessions/${session.id}/events`, { events: [{ type: "user.message", data: { text: "Reply OK" } }] }));
      await router.handleNewEvent(session.id, (await stores.agentStore.getById(agent.id))!);
      expect(requests).toHaveLength(before + 1);
      expect(requests.at(-1)).toMatchObject({ model: modelId, thinking: { type: "adaptive" }, output_config: { effort } });
      expect(requests.at(-1)!.thinking).not.toHaveProperty("budget_tokens");
    }
    const events = await json(await app.request(`/v1/sessions/${session.id}/events?limit=1000`));
    expect(events.data.filter((event: { type: string }) => event.type === "session.turn_completed")).toHaveLength(7);
    expect(events.data.filter((event: { type: string }) => event.type === "session.error")).toEqual([]);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);
