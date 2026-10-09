import { afterEach, expect, it, vi } from "vitest";
import { createMemoryStores } from "@oma-server/store-memory";
import { createApp } from "../src/app.js";
import { runnerThinkingOptions } from "../src/lib/thinking-options.js";
const options = {
  model: "openai-codex/gpt-6-astra",
  choices: [{ value: "low", label: "low" }, { value: "medium", label: "medium" }, { value: "high", label: "high" }, { value: "xhigh", label: "xhigh" }, { value: "max", label: "max" }],
  resolvedLevels: { off: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" }, defaultLevel: "max",
} as import("@open-managed-agents/adapter-pi-agent").ThinkingOptions;
afterEach(() => vi.unstubAllEnvs());
it("uses the live Agent model, retains Loop snapshots, and checks tenant and deletion", async () => {
  vi.stubEnv("AUTH_DISABLED", "true");
  const stores = createMemoryStores();
  const reader = vi.fn(async () => options);
  const app = createApp({ ...stores, thinkingOptions: reader });
  const agent = await stores.agentStore.create({ tenantId: "dev", name: "Test", model: "old", runtime: "pi-agent", system: "test" });
  const workspace = await stores.workspaceStore.create({ tenantId: "dev" });
  const normal = await stores.sessionStore.create({ tenantId: "dev", agentId: agent.id, agent, workspaceId: workspace.id });
  const loop = await stores.sessionStore.create({ tenantId: "dev", agentId: agent.id, agent, workspaceId: workspace.id, loopId: "loop" });
  const foreign = await stores.sessionStore.create({ tenantId: "other", agentId: agent.id, agent, workspaceId: workspace.id });
  await stores.agentStore.update(agent.id, { model: options.model });
  const get = (id: string) => app.request(`/v1/sessions/${id}/thinking-options`);
  const response = await get(normal.id);
  expect(response.status).toBe(200);
  expect((await response.json()).choices).toHaveLength(5);
  expect(reader).toHaveBeenLastCalledWith("dev", options.model);
  expect((await get(loop.id)).status).toBe(200);
  expect(reader).toHaveBeenLastCalledWith("dev", "old");
  expect((await get(foreign.id)).status).toBe(404);
  expect(reader).toHaveBeenCalledTimes(2);
  reader.mockRejectedValueOnce(new Error("sensitive upstream error"));
  const failure = await get(normal.id);
  expect(failure.status).toBe(503);
  expect(await failure.text()).not.toContain("sensitive");
  await stores.workspaceStore.softDelete("dev", workspace.id);
  expect((await get(normal.id)).status).toBe(404);
});
it("queries only the configured Runner URL and strips extra response fields", async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ ...options, apiKey: "private" }));
  const read = runnerThinkingOptions("http://runner:3001", request);
  expect(await read(options.model)).toEqual(options);
  const [url, init] = request.mock.calls[0];
  expect(String(url)).toBe("http://runner:3001/model-thinking-options?model=openai-codex%2Fgpt-6-astra");
  expect(init?.redirect).toBe("error");
});
it("reads only the owning Tenant's custom metadata without decrypting its key", async () => {
  const { ModelProviderService } = await import("../src/lib/model-providers.js");
  const stores = createMemoryStores();
  const provider = "custom-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  await stores.modelProviderStore.save({ tenantId: "owner", id: provider, name: "Private gateway", api: "openai-completions", baseUrl: "https://private.example.com", encryptedApiKey: "not-a-decryptable-key", testedAt: new Date().toISOString(), models: [{ id: "model", name: "Model", reasoning: false, contextWindow: 32768, maxTokens: 1024, input: ["text"] }] });
  const service = new ModelProviderService(stores.modelProviderStore, undefined);
  const managed = vi.fn();
  const result = await service.thinkingOptions("owner", `${provider}/model`, managed);
  expect(result.choices).toEqual([{ value: "off", label: "off" }]);
  expect(managed).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain("private.example.com");
  await expect(service.thinkingOptions("other", `${provider}/model`, managed)).rejects.toMatchObject({ status: 404 });
});
