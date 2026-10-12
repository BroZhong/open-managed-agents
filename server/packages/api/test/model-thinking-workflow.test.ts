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

it("carries discovered capabilities through save, Agent/Session preferences and actual Pi Turns", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "oma-thinking-workflow-"));
  vi.stubEnv("AUTH_DISABLED", "true");
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [
      { id: "vendor/unknown", name: "Unknown" },
      { id: "vendor/plain", name: "Plain", reasoning: false },
    ] });
    expect(String(url)).toBe("https://gateway.example.com/v1/chat/completions");
    requests.push(JSON.parse(String(init?.body)));
    return new Response([
      { id: "chat-1", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] },
      { id: "chat-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
  }));
  const stores = createMemoryStores();
  const service = new ModelProviderService(stores.modelProviderStore, "ab".repeat(32));
  const adapter = new PiAgentAdapter({ configureModelRuntime: service.configureRuntime(stores.sessionStore) });
  const router = new SessionRouter({ ...stores, eventStreamHub: new InProcessEventStreamHub(), resolveAdapter: () => adapter });
  const app = createApp({ ...stores, modelProviderService: service,
    thinkingOptions: (tenant, model) => service.thinkingOptions(tenant, model, async () => { throw new Error("Unexpected managed lookup"); }),
  });
  const post = (url: string, body: unknown) => app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = async (response: Response) => {
    const result = await response.json();
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  try {
    const connection = { api: "openai-completions", baseUrl: "https://gateway.example.com/v1", apiKey: "controlled-test-key" };
    const discovered = await json(await post("/v1/model-providers/discover", connection));
    expect(discovered.data[0]).toMatchObject({ reasoning: true, reasoningSource: "default", capabilityVersion: 1 });
    expect(discovered.data[1]).toMatchObject({ reasoning: false, reasoningSource: "upstream", capabilityVersion: 1 });
    expect(requests).toHaveLength(0);
    const config = { ...connection, name: "Gateway", models: discovered.data };
    const proof = await json(await post("/v1/model-providers/test", config));
    expect(requests).toHaveLength(2);
    const saved = await json(await post("/v1/model-providers", { ...config, verificationToken: proof.verificationToken }));
    expect(requests).toHaveLength(2);
    const model = `${saved.id}/vendor/unknown`;
    const capability = await json(await app.request(`/v1/model-thinking-options?model=${encodeURIComponent(model)}`));
    expect(capability.defaultLevel).toBe("high");
    expect(capability.resolvedLevels.max).toBe("high");
    expect(requests).toHaveLength(2);
    const agent = await json(await post("/v1/agents", { name: "Thinking", model, runtime: "pi-agent", system: "Reply briefly", thinking: "max", sandbox: { enabled: false } }));
    const session = await json(await post("/v1/sessions", { agent: agent.id }));
    const sessionOptions = () => app.request(`/v1/sessions/${session.id}/thinking-options`).then(json);
    expect(await sessionOptions()).toEqual(capability);
    const turn = async () => {
      const before = requests.length;
      await json(await post(`/v1/sessions/${session.id}/events`, { events: [{ type: "user.message", data: { text: "Hello" } }] }));
      await router.handleNewEvent(session.id, (await stores.agentStore.getById(agent.id))!);
      const events = await json(await app.request(`/v1/sessions/${session.id}/events?limit=1000`));
      expect(events.data.filter((event: { type: string }) => event.type === "session.error")).toEqual([]);
      expect(requests).toHaveLength(before + 1);
      return requests.at(-1)!;
    };
    expect(await turn()).toMatchObject({ model: "vendor/unknown", reasoning_effort: "high" });
    await json(await post(`/v1/sessions/${session.id}`, { thinking: "low" }));
    expect(await turn()).toMatchObject({ reasoning_effort: "low" });
    await json(await post(`/v1/agents/${agent.id}`, { thinking: "medium" }));
    expect(await turn()).toMatchObject({ reasoning_effort: "low" });
    await json(await post(`/v1/sessions/${session.id}`, { thinking: null }));
    expect(await turn()).toMatchObject({ reasoning_effort: "medium" });
    await json(await post(`/v1/agents/${agent.id}`, { model: `${saved.id}/vendor/plain` }));
    expect((await sessionOptions()).choices).toEqual([{ value: "off", label: "off" }]);
    const plain = await turn();
    expect(plain.model).toBe("vendor/plain");
    expect(plain).not.toHaveProperty("reasoning_effort");
    expect((await json(await app.request(`/v1/agents/${agent.id}`))).thinking).toBe("medium");
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
}, 30_000);
