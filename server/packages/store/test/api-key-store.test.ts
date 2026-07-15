import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PgApiKeyStore } from "../src/postgres/api-key-store.js";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";

describe("PgApiKeyStore", () => {
  let harness: PgTestHarness;
  let store: PgApiKeyStore;

  beforeAll(async () => {
    harness = await createPgTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
    store = new PgApiKeyStore(harness.pool);
  });

  it("should create an API key with omak_ prefix and return raw key", async () => {
    const result = await store.create("tenant1", "My Key");

    expect(result.rawKey).toMatch(/^omak_/);
    expect(result.apiKey.id).toMatch(/^apikey_/);
    expect(result.apiKey.tenantId).toBe("tenant1");
    expect(result.apiKey.name).toBe("My Key");
    expect(result.apiKey.prefix).toBe(result.rawKey.slice(0, 9));
    expect(result.apiKey.keyHash).not.toBe(result.rawKey);
    expect(result.apiKey.createdAt).toBeInstanceOf(Date);
  });

  it("should validate a correct raw key", async () => {
    const { rawKey, apiKey } = await store.create("tenant1", "My Key");

    const validated = await store.validate(rawKey);
    expect(validated).not.toBeNull();
    expect(validated!.id).toBe(apiKey.id);
    expect(validated!.tenantId).toBe("tenant1");
  });

  it("should return null for an incorrect key", async () => {
    await store.create("tenant1", "My Key");

    const validated = await store.validate("omak_wrong_key_here");
    expect(validated).toBeNull();
  });

  it("should return null for a completely invalid key", async () => {
    const validated = await store.validate("invalid");
    expect(validated).toBeNull();
  });

  it("should revoke an API key while retaining it for historical usage", async () => {
    const { rawKey, apiKey } = await store.create("tenant1", "My Key");

    const revoked = await store.revoke("tenant1", apiKey.id);
    expect(revoked).toBe(true);

    const validated = await store.validate(rawKey);
    expect(validated).toBeNull();
    await expect(store.findByKeyHash(apiKey.keyHash)).resolves.toBeNull();
    const listed = await store.list("tenant1");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: apiKey.id, revokedAt: expect.any(Date) });
    await expect(store.revoke("tenant1", apiKey.id)).resolves.toBe(false);
  });

  it("should return false when revoking a non-existent key", async () => {
    const revoked = await store.revoke("tenant1", "apikey_nonexistent");
    expect(revoked).toBe(false);
  });

  it("must not revoke another tenant's API key", async () => {
    const { rawKey, apiKey } = await store.create("tenant2", "Their Key");

    await expect(store.revoke("tenant1", apiKey.id)).resolves.toBe(false);
    await expect(store.validate(rawKey)).resolves.toMatchObject({ id: apiKey.id });
  });

  it("returns both tenant and key identity for request attribution", async () => {
    const { apiKey } = await store.create("tenant1", "Attributed Key");

    await expect(store.findByKeyHash(apiKey.keyHash)).resolves.toEqual({
      tenantId: "tenant1",
      apiKeyId: apiKey.id,
    });
  });

  it("should list keys for a tenant", async () => {
    await store.create("tenant1", "Key 1");
    await store.create("tenant1", "Key 2");
    await store.create("tenant2", "Other");

    const t1 = await store.list("tenant1");
    expect(t1).toHaveLength(2);
    const t2 = await store.list("tenant2");
    expect(t2).toHaveLength(1);
  });

  it("should create multiple keys for same tenant", async () => {
    const key1 = await store.create("tenant1", "Key 1");
    const key2 = await store.create("tenant1", "Key 2");

    expect(key1.rawKey).not.toBe(key2.rawKey);
    expect(key1.apiKey.id).not.toBe(key2.apiKey.id);

    const v1 = await store.validate(key1.rawKey);
    const v2 = await store.validate(key2.rawKey);
    expect(v1).not.toBeNull();
    expect(v2).not.toBeNull();
  });
});
