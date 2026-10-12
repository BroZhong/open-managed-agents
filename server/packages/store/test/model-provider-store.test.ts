import { afterAll, beforeAll, expect, it } from "vitest";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";
import { PgModelProviderStore } from "../src/postgres/model-provider-store.js";
import type { ModelProviderRecord } from "../src/interfaces/model-provider-store.js";
import { migrateModelProviderCapabilities } from "../src/postgres/migrate-model-provider-capabilities.js";
let harness: PgTestHarness;
beforeAll(async () => {
  harness = await createPgTestHarness();
});
afterAll(async () => {
  await harness.close();
});
it("persists provider updates across store instances with Tenant-scoped read and deletion", async () => {
  const first = new PgModelProviderStore(harness.pool);
  const record: ModelProviderRecord = {
    id: "custom-one",
    tenantId: "a",
    name: "One",
    api: "openai-completions",
    baseUrl: "https://example.com",
    encryptedApiKey: "ciphertext",
    models: [],
    testedAt: new Date().toISOString(),
  };
  await first.save(record);
  const second = new PgModelProviderStore(harness.pool);
  expect(await second.get("a", record.id)).toEqual(record);
  expect(await second.get("b", record.id)).toBeNull();
  await second.save({ ...record, name: "Updated" });
  expect((await first.list("a"))[0].name).toBe("Updated");
  expect(await second.delete("b", record.id)).toBe(false);
  expect(await second.delete("a", record.id)).toBe(true);
  expect(await first.list("a")).toEqual([]);
});

it("upgrades legacy capability provenance without changing connections, references or modern settings", async () => {
  const store = new PgModelProviderStore(harness.pool);
  const model = { id: "alias", name: "Alias", reasoning: false, contextWindow: 32768, maxTokens: 4096, input: ["text"] as ("text" | "image")[] };
  const record: ModelProviderRecord = {
    tenantId: "migration", id: "custom-migration", name: "Gateway", api: "openai-completions",
    baseUrl: "https://gateway.example.com/v1", encryptedApiKey: "unchanged-ciphertext", testedAt: "2026-01-01T00:00:00.000Z",
    models: [model, { ...model, id: "old-true", reasoning: true }, { ...model, id: "gpt-5.4", catalogProvider: "openai" },
      { ...model, id: "explicit", reasoningSource: "upstream", capabilityVersion: 1 },
      { ...model, id: "manual", capabilityReference: { provider: "openai", modelId: "gpt-5.4" }, thinkingMode: "provider" }],
  };
  await store.save(record);
  expect(await migrateModelProviderCapabilities(harness.pool)).toMatchObject({ scanned: 1, candidates: 1, updated: 0 });
  expect(await store.get(record.tenantId, record.id)).toEqual(record);
  expect(await migrateModelProviderCapabilities(harness.pool, { apply: true })).toMatchObject({ updated: 1, conflicts: 0 });
  const upgraded = await new PgModelProviderStore(harness.pool).get(record.tenantId, record.id);
  expect(upgraded).toEqual({ ...record, models: record.models.map((entry, index) => index < 3 ? { ...entry, reasoning: true, reasoningSource: "legacy", capabilityVersion: 1 } : entry) });
  expect(await migrateModelProviderCapabilities(harness.pool, { apply: true })).toMatchObject({ candidates: 0, updated: 0 });
  expect(await store.get(record.tenantId, record.id)).toEqual(upgraded);
});

it("does not overwrite a concurrent provider edit and safely resumes on the next run", async () => {
  const store = new PgModelProviderStore(harness.pool);
  const record: ModelProviderRecord = {
    tenantId: "race", id: "custom-race", name: "Original", api: "openai-responses", baseUrl: "https://example.com/v1",
    encryptedApiKey: "ciphertext", testedAt: "2026-01-01T00:00:00.000Z",
    models: [{ id: "alias", name: "Alias", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 4096 }],
  };
  await store.save(record);
  let raced = false;
  const concurrentPool = { query: async (sql: string, values: unknown[]) => {
    if (sql.startsWith("UPDATE model_providers") && !raced) {
      raced = true;
      await store.save({ ...record, name: "Concurrent edit" });
    }
    return harness.pool.query(sql, values);
  } } as typeof harness.pool;
  expect(await migrateModelProviderCapabilities(concurrentPool, { apply: true })).toMatchObject({ conflicts: 1, updated: 0 });
  expect(await store.get("race", record.id)).toEqual({ ...record, name: "Concurrent edit" });
  expect(await migrateModelProviderCapabilities(harness.pool, { apply: true })).toMatchObject({ conflicts: 0, updated: 1 });
  expect(await store.get("race", record.id)).toMatchObject({ name: "Concurrent edit", encryptedApiKey: "ciphertext", models: [{ reasoning: true, reasoningSource: "legacy", capabilityVersion: 1 }] });
});
