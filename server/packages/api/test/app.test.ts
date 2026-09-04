import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApp } from "../src/app.js";
import type { ApiKeyStore, TenantContext } from "../src/types.js";
import { createHash } from "node:crypto";

function makeStore(entries: Map<string, TenantContext>): ApiKeyStore {
  return {
    async findByKeyHash(keyHash) {
      return entries.get(keyHash) ?? null;
    },
  };
}

describe("GET /health", () => {
  it("returns 200 with { status: 'ok' }", async () => {
    const app = createApp({ apiKeyStore: makeStore(new Map()) });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("/v1/* auth", () => {
  const originalEnv = process.env.AUTH_DISABLED;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AUTH_DISABLED;
    } else {
      process.env.AUTH_DISABLED = originalEnv;
    }
  });

  it("returns 401 without x-api-key header", async () => {
    delete process.env.AUTH_DISABLED;
    const app = createApp({ apiKeyStore: makeStore(new Map()) });
    // Add a dummy route so we can test the middleware
    app.get("/v1/test", (c) => c.json({ ok: true }));

    const res = await app.request("/v1/test");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns 401 with invalid key", async () => {
    delete process.env.AUTH_DISABLED;
    const app = createApp({ apiKeyStore: makeStore(new Map()) });
    app.get("/v1/test", (c) => c.json({ ok: true }));

    const res = await app.request("/v1/test", {
      headers: { "x-api-key": "bad-key" },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("passes auth with valid key and sets tenant context", async () => {
    delete process.env.AUTH_DISABLED;
    const validKey = "test-api-key-123";
    const keyHash = createHash("sha256").update(validKey).digest("hex");
    const store = makeStore(new Map([[keyHash, { tenantId: "tenant-1" }]]));
    const app = createApp({ apiKeyStore: store });
    app.get("/v1/test", (c) => {
      const tenant = c.get("tenant");
      return c.json({ tenantId: tenant.tenantId });
    });

    const res = await app.request("/v1/test", {
      headers: { "x-api-key": validKey },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenantId: "tenant-1" });
  });

  it("bypasses auth when AUTH_DISABLED=true", async () => {
    process.env.AUTH_DISABLED = "true";
    const app = createApp({ apiKeyStore: makeStore(new Map()) });
    app.get("/v1/test", (c) => {
      const tenant = c.get("tenant");
      return c.json({ tenantId: tenant.tenantId });
    });

    const res = await app.request("/v1/test");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenantId: "dev" });
  });
});

describe("API_BASE_PATH mount prefix", () => {
  const originalBasePath = process.env.API_BASE_PATH;
  const originalAuthDisabled = process.env.AUTH_DISABLED;

  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  afterEach(() => {
    if (originalBasePath === undefined) {
      delete process.env.API_BASE_PATH;
    } else {
      process.env.API_BASE_PATH = originalBasePath;
    }
    if (originalAuthDisabled === undefined) {
      delete process.env.AUTH_DISABLED;
    } else {
      process.env.AUTH_DISABLED = originalAuthDisabled;
    }
  });

  it("serves at the bare paths when unset", async () => {
    delete process.env.API_BASE_PATH;
    const app = createApp({ apiKeyStore: makeStore(new Map()) });
    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/api/health")).status).toBe(404);
  });

  it("serves every route under the prefix when set", async () => {
    process.env.API_BASE_PATH = "/api";
    const app = createApp({ apiKeyStore: makeStore(new Map()) });
    app.get("/v1/test", (c) => c.json({ tenantId: c.get("tenant").tenantId }));

    // Prefixed paths resolve, including the /v1/* auth middleware.
    expect((await app.request("/api/health")).status).toBe(200);
    const res = await app.request("/api/v1/test");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenantId: "dev" });

    // The unprefixed paths are no longer served.
    expect((await app.request("/health")).status).toBe(404);
    expect((await app.request("/v1/test")).status).toBe(404);
  });

  it("tolerates a missing leading slash and a trailing slash", async () => {
    for (const raw of ["api", "/api/", "api/"]) {
      process.env.API_BASE_PATH = raw;
      const app = createApp({ apiKeyStore: makeStore(new Map()) });
      expect((await app.request("/api/health")).status).toBe(200);
    }
  });

  it("treats a lone slash as no prefix", async () => {
    process.env.API_BASE_PATH = "/";
    const app = createApp({ apiKeyStore: makeStore(new Map()) });
    expect((await app.request("/health")).status).toBe(200);
  });
});
