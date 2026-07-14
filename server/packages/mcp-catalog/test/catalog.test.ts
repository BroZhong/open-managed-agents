import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listManagedMcpCatalog,
  normalizeManagedMcpRefs,
  resolveManagedMcpServers,
} from "../src/index.js";

describe("managed MCP catalog", () => {
  const originalAllowedTenants = process.env.OMA_SUPABASE_ALLOWED_TENANTS;

  beforeEach(() => {
    delete process.env.OMA_SUPABASE_ALLOWED_TENANTS;
  });

  afterEach(() => {
    if (originalAllowedTenants === undefined) {
      delete process.env.OMA_SUPABASE_ALLOWED_TENANTS;
    } else {
      process.env.OMA_SUPABASE_ALLOWED_TENANTS = originalAllowedTenants;
    }
  });

  it("resolves the Supabase reference to the pinned Host stdio connection", () => {
    process.env.OMA_SUPABASE_ALLOWED_TENANTS = "tenant-a";
    const resolved = resolveManagedMcpServers([
      {
        catalogId: "aliyun-rds-supabase",
        name: "session-data",
        description: "Read recent Sessions",
      },
    ], { tenantId: "tenant-a" });
    const entrypoint = resolve(
      fileURLToPath(new URL(".", import.meta.url)),
      "../src/supabase-session-mcp.ts",
    );
    expect(resolved).toEqual([
      {
        name: "session-data",
        command: process.execPath,
        args: [
          "--import",
          expect.stringMatching(/^file:.*tsx.*loader\.mjs$/),
          entrypoint,
        ],
        env: {
          ALIYUN_ACCESS_KEY_ID: "${ALIYUN_ACCESS_KEY_ID}",
          ALIYUN_ACCESS_KEY_SECRET: "${ALIYUN_ACCESS_KEY_SECRET}",
          ALIBABA_CLOUD_ACCESS_KEY_ID: "${ALIBABA_CLOUD_ACCESS_KEY_ID}",
          ALIBABA_CLOUD_ACCESS_KEY_SECRET: "${ALIBABA_CLOUD_ACCESS_KEY_SECRET}",
          ALIYUN_REGION: "${ALIYUN_REGION}",
          OMA_TENANT_ID: "tenant-a",
        },
      },
    ]);
  });

  it("refuses to resolve the Supabase connection without a Host tenant", () => {
    process.env.OMA_SUPABASE_ALLOWED_TENANTS = "tenant-a";
    expect(() => resolveManagedMcpServers([{
      catalogId: "aliyun-rds-supabase",
      name: "session-data",
    }])).toThrow("requires a tenant");
  });

  it("refuses to resolve Supabase for a tenant outside the deployment allowlist", () => {
    process.env.OMA_SUPABASE_ALLOWED_TENANTS = "tenant-a, tenant-b";

    expect(() => resolveManagedMcpServers([{
      catalogId: "aliyun-rds-supabase",
      name: "session-data",
    }], { tenantId: "tenant-c" })).toThrow("not available for this tenant");
  });

  it("publishes configurable metadata without leaking private connection details", () => {
    process.env.OMA_SUPABASE_ALLOWED_TENANTS = "tenant-a";
    const supabase = listManagedMcpCatalog({ tenantId: "tenant-a" }).find(
      (entry) => entry.id === "aliyun-rds-supabase",
    );

    expect(supabase).toMatchObject({
      defaultName: "aliyun-rds-supabase",
      transport: "stdio",
      configurable: ["name", "description"],
    });
    expect(supabase).not.toHaveProperty("command");
    expect(supabase).not.toHaveProperty("connection");
  });

  it("hides Supabase metadata when the deployment allowlist is absent", () => {
    expect(listManagedMcpCatalog({ tenantId: "tenant-a" })).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "aliyun-rds-supabase" }),
      ]),
    );
  });

  it("rejects new raw RDS connection input while retaining runtime compatibility", () => {
    const legacy = {
      name: "rds-mcp",
      url: "https://campaign.welltop.tech/agent/mcp/rds",
      transport: "streamable-http",
      headers: { Authorization: "Bearer ${RDS_MCP_APIKEY}" },
    } as const;

    expect(normalizeManagedMcpRefs([legacy], { tenantId: "tenant-a" })).toEqual({
      error: "mcpServers[0].catalogId is not in the managed MCP catalog",
    });
    expect(resolveManagedMcpServers([legacy])).toEqual([legacy]);
  });

  it("rejects legacy RDS records carrying executable fields", () => {
    const unsafeLegacy = {
      name: "rds-mcp",
      url: "https://campaign.welltop.tech/agent/mcp/rds",
      transport: "streamable-http",
      headers: { Authorization: "Bearer ${RDS_MCP_APIKEY}" },
      command: "sh",
      args: ["-c", "id"],
      env: { LEAK: "${PG_PASSWORD}" },
      cwd: "/",
    } as const;

    expect(() => resolveManagedMcpServers([
      unsafeLegacy as unknown as Parameters<typeof resolveManagedMcpServers>[0][number],
    ])).toThrow("not Host-managed");
  });
});
