import { OpenAPIHono } from "@hono/zod-openapi";
import { openApiRoutes } from "./routes.js";

const DEFAULT_SERVER_URL = "http://localhost:3000";

export interface CreateOpenApiDocumentOptions {
  serverUrl?: string;
}

export type OpenApiDocument = ReturnType<OpenAPIHono["getOpenAPI31Document"]>;

export function createOpenApiDocument(
  options: CreateOpenApiDocumentOptions = {},
): OpenApiDocument {
  const registry = new OpenAPIHono();

  registry.openAPIRegistry.registerComponent("securitySchemes", "ApiKeyAuth", {
    type: "apiKey",
    in: "header",
    name: "x-api-key",
    description: "Tenant API key issued by POST /v1/api-keys.",
  });
  registry.openAPIRegistry.registerComponent("securitySchemes", "BearerAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description: "Tenant session token issued by POST /auth/login.",
  });

  for (const route of openApiRoutes) {
    registry.openAPIRegistry.registerPath(route);
  }

  const serverUrl = (
    options.serverUrl ??
    process.env.PUBLIC_API_URL ??
    DEFAULT_SERVER_URL
  ).replace(/\/+$/, "");

  return registry.getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: "Open Managed Agents API",
      version: "0.1.0",
      description:
        "HTTP API for managing Agents, managed MCP servers, Loops, Skills, Workspaces, Sessions, Events, API keys, and Workspace files.",
    },
    servers: [{ url: serverUrl }],
    security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
    tags: [
      { name: "System", description: "Service health and metadata." },
      {
        name: "Authentication",
        description: "User registration and Tenant session tokens.",
      },
      {
        name: "Agents",
        description: "Agent definitions and runtime configuration.",
      },
      {
        name: "MCP Catalog",
        description:
          "Host-reviewed MCP servers that can be safely equipped on Agents.",
      },
      {
        name: "Loops",
        description: "Scheduled and on-demand recurring Agent work.",
      },
      {
        name: "Agents/Files",
        description: "Editable Agent Files that shape identity and instructions.",
      },
      {
        name: "Agents/Skills",
        description: "Skill Forks equipped on an Agent.",
      },
      {
        name: "Skills",
        description: "Tenant Skill Library and Skill metadata.",
      },
      {
        name: "Skills/Files",
        description: "Files contained in a Skill directory.",
      },
      {
        name: "API Keys",
        description: "Tenant API credentials and their token usage.",
      },
      { name: "Workspaces", description: "Tenant-owned Workspace metadata." },
      { name: "Sessions", description: "Agent Sessions bound to Workspaces." },
      {
        name: "Sessions/Usage",
        description: "Aggregated token usage for a Session.",
      },
      {
        name: "Sessions/Events",
        description:
          "Durable user input and Complete Events, with optional live Deltas.",
      },
      {
        name: "Sessions/Messages",
        description: "Legacy same-request streaming messages.",
      },
      {
        name: "Sessions/Workspace Files",
        description: "File operations within a Session's Workspace.",
      },
    ],
  });
}

export function serializeOpenApiDocument(document: OpenApiDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
