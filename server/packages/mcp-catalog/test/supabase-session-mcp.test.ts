import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { resolveManagedMcpServers } from "../src/index.js";

describe("Supabase Session stdio MCP", () => {
  it("uses its Host cwd instead of a missing sandbox cwd and exposes one read-only tool", async () => {
    const originalAllowedTenants = process.env.OMA_SUPABASE_ALLOWED_TENANTS;
    process.env.OMA_SUPABASE_ALLOWED_TENANTS = "tenant-test";
    try {
      const [definition] = resolveManagedMcpServers([{
        catalogId: "aliyun-rds-supabase",
        name: "session-data",
      }], { tenantId: "tenant-test" }) ?? [];
      if (!definition || !("command" in definition)) {
        throw new Error("Expected a resolved stdio MCP definition");
      }

      const missingSandboxCwd = resolve(
        import.meta.dirname,
        "__missing-sandbox-workspace__",
      );
      expect(existsSync(missingSandboxCwd)).toBe(false);
      expect(definition.cwd).toBeTruthy();
      expect(existsSync(definition.cwd!)).toBe(true);

      const transport = new StdioClientTransport({
        command: definition.command,
        args: definition.args,
        cwd: definition.cwd ?? missingSandboxCwd,
        env: {
          ...process.env,
          ...definition.env,
          ALIYUN_ACCESS_KEY_ID: "unused-test-key",
          ALIYUN_ACCESS_KEY_SECRET: "unused-test-secret",
          ALIYUN_REGION: "cn-hongkong",
        },
        stderr: "pipe",
      });
      const client = new Client({ name: "mcp-test", version: "1.0.0" });
      try {
        await client.connect(transport);
        const tools = await client.listTools();
        expect(tools.tools).toEqual([
          expect.objectContaining({
            name: "query_recent_sessions",
            annotations: expect.objectContaining({
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
            }),
          }),
        ]);
        expect(tools.tools[0]?.inputSchema).toMatchObject({
          type: "object",
          properties: {
            days: expect.any(Object),
            session_limit: expect.any(Object),
            event_limit_per_session: expect.any(Object),
          },
        });
      } finally {
        await client.close();
      }
    } finally {
      if (originalAllowedTenants === undefined) {
        delete process.env.OMA_SUPABASE_ALLOWED_TENANTS;
      } else {
        process.env.OMA_SUPABASE_ALLOWED_TENANTS = originalAllowedTenants;
      }
    }
  }, 15_000);
});
