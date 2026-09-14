import { describe, it, expect, beforeEach, vi } from "vitest";
import { createApp } from "../src/app.js";
import { InMemoryApiKeyStore, InMemoryEventLogStore } from "@oma-server/store-memory";

function createTestApp(options: { includeEventLog?: boolean } = {}) {
  process.env.AUTH_DISABLED = "true";
  const apiKeyStore = new InMemoryApiKeyStore();
  const eventLogStore = new InMemoryEventLogStore();
  const app = createApp({
    apiKeyStore,
    fullApiKeyStore: apiKeyStore,
    ...(options.includeEventLog === false ? {} : { eventLogStore }),
  });
  return { app, apiKeyStore, eventLogStore };
}

describe("CORS headers", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("includes CORS headers on responses", async () => {
    const { app } = createTestApp();
    const res = await app.request("/health", {
      headers: { Origin: "http://localhost:5173" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("responds to preflight OPTIONS requests", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/api-keys", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-api-key",
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toBeTruthy();
  });
});

describe("POST /v1/api-keys", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("creates a key and returns the full key", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "my-key" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.name).toBe("my-key");
    expect(body.key).toBeDefined();
    expect(body.prefix).toBeDefined();
    expect(body.createdAt).toBeDefined();
  });

  it("returns 400 when name is missing", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("name is required");
  });

  it("returns 400 for invalid JSON body", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid JSON body");
  });
});

describe("GET /v1/api-keys", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("returns empty list when no keys exist", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/api-keys");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.has_more).toBe(false);
  });

  it("returns 503 without a usage store while POST and DELETE remain available", async () => {
    const { app, apiKeyStore } = createTestApp({ includeEventLog: false });
    const existing = await apiKeyStore.create("dev", "existing");

    const listRes = await app.request("/v1/api-keys");
    expect(listRes.status).toBe(503);
    expect(await listRes.json()).toEqual({ error: "Usage service unavailable" });

    const createRes = await app.request("/v1/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "new" }),
    });
    expect(createRes.status).toBe(201);

    const deleteRes = await app.request(`/v1/api-keys/${existing.apiKey.id}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(200);
  });

  it("returns list of keys without full key or keyHash", async () => {
    const { app, apiKeyStore } = createTestApp();
    await apiKeyStore.create("dev", "key-one");
    await apiKeyStore.create("dev", "key-two");

    const res = await app.request("/v1/api-keys");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0].name).toBe("key-one");
    expect(body.data[1].name).toBe("key-two");
    // Must not expose full key or keyHash
    expect(body.data[0].key).toBeUndefined();
    expect(body.data[0].keyHash).toBeUndefined();
  });

  it("create response returns full key only once (not in list)", async () => {
    const { app } = createTestApp();
    const createRes = await app.request("/v1/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ephemeral" }),
    });
    const createBody = await createRes.json();
    expect(createBody.key).toBeDefined();

    const listRes = await app.request("/v1/api-keys");
    const listBody = await listRes.json();
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0].key).toBeUndefined();
    expect(listBody.data[0].keyHash).toBeUndefined();
  });

  it("isolates keys by tenant", async () => {
    const { app, apiKeyStore } = createTestApp();
    await apiKeyStore.create("dev", "dev-key");
    await apiKeyStore.create("other-tenant", "other-key");

    const res = await app.request("/v1/api-keys");
    const body = await res.json();
    // AUTH_DISABLED=true sets tenant to "dev"
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe("dev-key");
  });

  it("includes exact snake_case usage for each API key", async () => {
    const { app, apiKeyStore, eventLogStore } = createTestApp();
    const { apiKey } = await apiKeyStore.create("dev", "metered-key");
    await eventLogStore.append("sess_1", {
      type: "span.model_request_end",
      data: {
        usage: {
          inputTokens: 100,
          outputTokens: 25,
          cacheReadTokens: 40,
          cacheWriteTokens: 10,
        },
      },
      sessionThreadId: "thread_1",
      apiKeyId: apiKey.id,
    });

    const res = await app.request("/v1/api-keys");
    const body = await res.json();
    expect(body.data[0].usage).toEqual({
      input_tokens: 100,
      output_tokens: 25,
      cache_read_tokens: 40,
      cache_write_tokens: 10,
      total_tokens: 125,
      cache_hit_rate: 0.4,
    });
  });

  it("loads list usage with one batch query", async () => {
    const { app, apiKeyStore, eventLogStore } = createTestApp();
    const first = await apiKeyStore.create("dev", "one");
    const second = await apiKeyStore.create("dev", "two");
    const batch = vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, {
      inputTokens: id === first.apiKey.id ? 10 : 20,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: id === first.apiKey.id ? 11 : 21,
      cacheHitRate: 0,
    }])));
    eventLogStore.getUsageByApiKeyIds = batch;
    eventLogStore.getUsage = vi.fn(async () => {
      throw new Error("per-key usage query should not run");
    });

    const res = await app.request("/v1/api-keys");

    expect(res.status).toBe(200);
    expect(batch).toHaveBeenCalledOnce();
    expect(batch).toHaveBeenCalledWith([first.apiKey.id, second.apiKey.id]);
  });
});

describe("DELETE /v1/api-keys/:id", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("revokes a key while retaining its usage", async () => {
    const { app, apiKeyStore, eventLogStore } = createTestApp();
    const { apiKey, rawKey } = await apiKeyStore.create("dev", "to-delete");
    await eventLogStore.append("sess_1", {
      type: "span.model_request_end",
      data: {
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          cacheReadTokens: 6,
          cacheWriteTokens: 0,
        },
      },
      sessionThreadId: "thread_1",
      apiKeyId: apiKey.id,
    });

    const res = await app.request(`/v1/api-keys/${apiKey.id}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("api_key_revoked");
    expect(body.id).toBe(apiKey.id);

    // Revocation preserves the list row so historical usage remains visible.
    const listRes = await app.request("/v1/api-keys");
    const listBody = await listRes.json();
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0]).toMatchObject({
      id: apiKey.id,
      revokedAt: expect.any(String),
      usage: expect.objectContaining({ total_tokens: 15 }),
    });
    await expect(apiKeyStore.validate(rawKey)).resolves.toBeNull();
  });

  it("returns 404 for non-existent key", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/api-keys/key_999", {
      method: "DELETE",
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
  });

  it("returns 404 and preserves a key owned by another tenant", async () => {
    const { app, apiKeyStore } = createTestApp();
    const { apiKey, rawKey } = await apiKeyStore.create("other-tenant", "theirs");

    const res = await app.request(`/v1/api-keys/${apiKey.id}`, { method: "DELETE" });

    expect(res.status).toBe(404);
    await expect(apiKeyStore.validate(rawKey)).resolves.toMatchObject({ id: apiKey.id });
  });
});
