import { describe, it, expect, beforeEach } from "vitest";
import { createApp } from "../src/app.js";
import { InMemoryApiKeyStore } from "@oma-server/store-memory";

function createTestApp() {
  process.env.AUTH_DISABLED = "true";
  const apiKeyStore = new InMemoryApiKeyStore();
  const app = createApp({
    apiKeyStore,
    fullApiKeyStore: apiKeyStore,
  });
  return { app, apiKeyStore };
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
});

describe("DELETE /v1/api-keys/:id", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("deletes a key", async () => {
    const { app, apiKeyStore } = createTestApp();
    const { apiKey } = await apiKeyStore.create("dev", "to-delete");

    const res = await app.request(`/v1/api-keys/${apiKey.id}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("api_key_deleted");
    expect(body.id).toBe(apiKey.id);

    // Verify it's actually deleted
    const listRes = await app.request("/v1/api-keys");
    const listBody = await listRes.json();
    expect(listBody.data).toHaveLength(0);
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
});
