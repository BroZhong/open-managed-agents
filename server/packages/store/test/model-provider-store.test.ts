import { afterAll, beforeAll, expect, it } from "vitest";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";
import { PgModelProviderStore } from "../src/postgres/model-provider-store.js";
import type { ModelProviderRecord } from "../src/interfaces/model-provider-store.js";
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
