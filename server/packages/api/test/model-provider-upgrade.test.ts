import { expect, it, vi } from "vitest";
import { PgModelProviderStore, createPgStores, migrateModelProviderCapabilities, type ModelProviderRecord } from "@oma-server/store";
import { createPgTestHarness } from "../../store/test/pg-harness.js";
import { ModelProviderService } from "../src/lib/model-providers.js";

it("upgrades stored legacy models into the same current Pi capabilities used by future Turns", async () => {
  const harness = await createPgTestHarness();
  try {
    const store = new PgModelProviderStore(harness.pool);
    const model = { id: "unregistered-model", name: "Model", reasoning: false, contextWindow: 32768, maxTokens: 4096, input: ["text"] as ("text" | "image")[] };
    const record: ModelProviderRecord = {
      tenantId: "owner", id: "custom-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Existing gateway", api: "openai-responses",
      baseUrl: "https://gateway.example.com/v1", encryptedApiKey: "ciphertext-never-decrypted", testedAt: "2026-01-01T00:00:00.000Z",
      models: [model, { ...model, id: "gpt-4.1", reasoning: true },
        { ...model, id: "gpt-5.4", catalogProvider: "openai" }, { ...model, id: "gateway/gpt-5.4" },
        { ...model, id: "manual-alias", capabilityReference: { provider: "openai", modelId: "gpt-5.4" } },
        { ...model, id: "upstream-disabled", reasoningSource: "upstream", capabilityVersion: 1 }],
    };
    await store.save(record);
    const stores = await createPgStores(harness.pool, { ensureSchema: false });
    const agent = await stores.agentStore.create({ tenantId: "owner", name: "Existing Agent", model: `${record.id}/${model.id}`, runtime: "pi-agent", system: "Keep working", thinking: "max" });
    const workspace = await stores.workspaceStore.create({ tenantId: "owner" });
    const created = await stores.sessionStore.create({ tenantId: "owner", agentId: agent.id, agent, workspaceId: workspace.id });
    const session = await stores.sessionStore.setThinking(created.id, "minimal");
    const probe = vi.fn();
    const discovery = vi.fn();
    const managed = vi.fn();
    const service = new ModelProviderService(store, undefined, probe, discovery);
    await migrateModelProviderCapabilities(harness.pool, { apply: true });
    const options = await Promise.all(record.models.map((entry) => service.thinkingOptions("owner", `${record.id}/${entry.id}`, managed)));
    expect(options.map((entry) => entry.defaultLevel)).toEqual(["high", "off", "xhigh", "high", "xhigh", "off"]);
    expect(options[3].recommendations).toEqual(expect.arrayContaining([expect.objectContaining({ modelId: "gpt-5.4" })]));
    expect(options[4]).toMatchObject({ source: "manual", reference: { provider: "openai", modelId: "gpt-5.4" } });
    const upgraded = await store.get("owner", record.id);
    expect(upgraded).toMatchObject({ ...record, models: expect.any(Array) });
    expect(upgraded!.models.map((entry) => entry.id)).toEqual(record.models.map((entry) => entry.id));
    expect(await stores.agentStore.getById(agent.id)).toEqual(agent);
    expect(await stores.sessionStore.getById(created.id)).toEqual(session);
    expect(await migrateModelProviderCapabilities(harness.pool, { apply: true })).toMatchObject({ updated: 0, conflicts: 0 });
    expect(probe).not.toHaveBeenCalled();
    expect(discovery).not.toHaveBeenCalled();
    expect(managed).not.toHaveBeenCalled();
    await expect(service.thinkingOptions("another", `${record.id}/${model.id}`, managed)).rejects.toMatchObject({ status: 404 });
  } finally {
    await harness.close();
  }
});
