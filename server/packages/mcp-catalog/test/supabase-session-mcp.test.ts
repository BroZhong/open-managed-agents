import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

describe("Supabase Session stdio MCP", () => {
  it("starts through node --import tsx and exposes exactly one read-only tool", async () => {
    const bin = resolve(import.meta.dirname, "../src/supabase-session-mcp.ts");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", bin],
      env: {
        ...process.env,
        OMA_TENANT_ID: "tenant-test",
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
  }, 15_000);
});
