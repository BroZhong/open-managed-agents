import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("GET /v1/mcp-catalog", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
    process.env.OMA_SUPABASE_ALLOWED_TENANTS = "dev";
  });

  afterEach(() => {
    delete process.env.OMA_SUPABASE_ALLOWED_TENANTS;
  });

  it("returns Host-reviewed metadata without runtime command details", async () => {
    const app = createApp({
      apiKeyStore: { findByKeyHash: async () => null },
    });

    const response = await app.request("/v1/mcp-catalog");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "aliyun-rds-supabase",
        defaultName: "aliyun-rds-supabase",
        transport: "stdio",
        configurable: ["name", "description"],
      }),
    ]));
    expect(JSON.stringify(body)).not.toContain("supabase-mcp");
    expect(JSON.stringify(body)).not.toContain("${ALIYUN_ACCESS_KEY_ID}");
  });

  it("omits Supabase for a tenant outside the deployment allowlist", async () => {
    process.env.OMA_SUPABASE_ALLOWED_TENANTS = "another-tenant";
    const app = createApp({
      apiKeyStore: { findByKeyHash: async () => null },
    });

    const response = await app.request("/v1/mcp-catalog");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "rds-mcp" }),
    ]));
    expect(body.data).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "aliyun-rds-supabase" }),
    ]));
  });
});
