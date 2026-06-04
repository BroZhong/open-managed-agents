import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { MongoApiKeyStore } from "../src/mongodb/api-key-store.js";

describe("MongoApiKeyStore", () => {
  let mongod: MongoMemoryServer;
  let client: MongoClient;
  let store: MongoApiKeyStore;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    client = new MongoClient(mongod.getUri());
    await client.connect();
  });

  afterAll(async () => {
    await client.close();
    await mongod.stop();
  });

  beforeEach(async () => {
    const db = client.db("test_apikeys");
    await db.dropDatabase();
    store = new MongoApiKeyStore(db);
    await store.ensureIndexes();
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

  it("should delete an API key", async () => {
    const { rawKey, apiKey } = await store.create("tenant1", "My Key");

    const deleted = await store.delete(apiKey.id);
    expect(deleted).toBe(true);

    // Should no longer validate
    const validated = await store.validate(rawKey);
    expect(validated).toBeNull();
  });

  it("should return false when deleting non-existent key", async () => {
    const deleted = await store.delete("apikey_nonexistent");
    expect(deleted).toBe(false);
  });

  it("should create multiple keys for same tenant", async () => {
    const key1 = await store.create("tenant1", "Key 1");
    const key2 = await store.create("tenant1", "Key 2");

    expect(key1.rawKey).not.toBe(key2.rawKey);
    expect(key1.apiKey.id).not.toBe(key2.apiKey.id);

    // Both should validate
    const v1 = await store.validate(key1.rawKey);
    const v2 = await store.validate(key2.rawKey);
    expect(v1).not.toBeNull();
    expect(v2).not.toBeNull();
  });
});
