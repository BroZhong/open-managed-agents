import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createSupabaseSessionReader,
  loadSupabaseSessionEnvironment,
} from "./supabase-session-reader.js";

type SessionReader = ReturnType<typeof createSupabaseSessionReader>;

export function createSupabaseSessionMcpServer(reader: SessionReader): McpServer {
  const server = new McpServer({
    name: "oma-supabase-sessions-readonly",
    version: "1.0.0",
  });
  server.registerTool(
    "query_recent_sessions",
    {
      title: "Query recent Sessions",
      description:
        "Read recent Open Managed Agents Sessions and bounded canonical events for the Host-bound tenant.",
      inputSchema: {
        days: z.number().int().min(1).max(30).default(7),
        session_limit: z.number().int().min(1).max(100).default(25),
        event_limit_per_session: z.number().int().min(1).max(200).default(50),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const result = await reader.queryRecentSessions(input);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : "Supabase session query failed";
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
        };
      }
    },
  );
  return server;
}

export async function main(): Promise<void> {
  const environment = loadSupabaseSessionEnvironment(process.env);
  const reader = createSupabaseSessionReader({
    tenantId: environment.tenantId,
    configuredInstance: environment.configuredInstance,
    credentialsProvider: async () => environment.credentials,
  });
  const server = createSupabaseSessionMcpServer(reader);
  await server.connect(new StdioServerTransport());
}

const isMain = process.argv[1]
  ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
  : false;

if (isMain) {
  main().catch(() => {
    console.error("Supabase Sessions MCP failed to start.");
    process.exitCode = 1;
  });
}
