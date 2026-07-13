import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { agentFileRoutes } from "../src/routes/agent-files.js";
import { agentSkillRoutes } from "../src/routes/agent-skills.js";
import { agentRoutes } from "../src/routes/agents.js";
import { apiKeyRoutes } from "../src/routes/api-keys.js";
import { authRoutes } from "../src/routes/auth.js";
import { eventRoutes } from "../src/routes/events.js";
import { messageRoutes } from "../src/routes/messages.js";
import { sessionRoutes } from "../src/routes/sessions.js";
import { skillRoutes } from "../src/routes/skills.js";
import { workspaceRoutes } from "../src/routes/workspace.js";
import { workspaceEntityRoutes } from "../src/routes/workspaces.js";
import {
  createOpenApiDocument,
  serializeOpenApiDocument,
} from "../src/openapi/document.js";

const originalAuthDisabled = process.env.AUTH_DISABLED;

afterEach(() => {
  if (originalAuthDisabled === undefined) delete process.env.AUTH_DISABLED;
  else process.env.AUTH_DISABLED = originalAuthDisabled;
});

function operationsOf(
  document: ReturnType<typeof createOpenApiDocument>,
): string[] {
  const operations: string[] = [];
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const method of [
      "get",
      "post",
      "put",
      "patch",
      "delete",
      "options",
      "head",
    ] as const) {
      if (pathItem?.[method])
        operations.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return operations.sort();
}

function operationIdsOf(
  document: ReturnType<typeof createOpenApiDocument>,
): string[] {
  const operationIds: string[] = [];
  for (const pathItem of Object.values(document.paths ?? {})) {
    for (const method of [
      "get",
      "post",
      "put",
      "patch",
      "delete",
      "options",
      "head",
    ] as const) {
      const operation = pathItem?.[method];
      if (operation?.operationId) operationIds.push(operation.operationId);
    }
  }
  return operationIds;
}

function normalizeHonoPath(path: string): string {
  return path
    .replace(/:([A-Za-z0-9_]+)\{[^}]+\}/g, "{$1}")
    .replace(/:([A-Za-z0-9_]+)/g, "{$1}")
    .replace(/\*/g, "{path}");
}

function runtimeOperations(): string[] {
  // Route factories register synchronously and do not access their adapters
  // until a request runs. Deliberately empty adapters therefore expose the
  // authoritative Hono routing inventory without setting up infrastructure.
  const adapter = {} as never;
  const routers = [
    authRoutes(adapter),
    agentRoutes(adapter),
    agentFileRoutes(adapter, adapter),
    agentSkillRoutes(adapter, adapter, adapter),
    skillRoutes(adapter, adapter),
    apiKeyRoutes(adapter),
    workspaceEntityRoutes(adapter),
    sessionRoutes({
      sessionStore: adapter,
      agentStore: adapter,
      workspaceStore: adapter,
    }),
    eventRoutes({
      eventLogStore: adapter,
      pendingEventStore: adapter,
      sessionStore: adapter,
    }),
    messageRoutes({
      eventLogStore: adapter,
      pendingEventStore: adapter,
      sessionStore: adapter,
      eventStreamHub: adapter,
      sessionRouter: adapter,
    }),
    workspaceRoutes({ sessionStore: adapter, artifactStore: adapter }),
  ];

  const minimalApp = createApp({ apiKeyStore: adapter });
  const records = [
    ...minimalApp.routes.filter((route) =>
      ["/health", "/openapi.json"].includes(route.path),
    ),
    ...routers.flatMap((router) => router.routes),
  ];

  return records
    .filter((route) =>
      ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(
        route.method,
      ),
    )
    .map((route) => `${route.method} ${normalizeHonoPath(route.path)}`)
    .sort();
}

describe("OpenAPI contract", () => {
  it("covers every current HTTP operation exactly once", () => {
    const document = createOpenApiDocument({
      serverUrl: "https://api.example.test",
    });

    const runtime = runtimeOperations();
    expect(operationsOf(document)).toEqual(runtime);

    const operationIds = operationIdsOf(document);
    expect(operationIds).toHaveLength(runtime.length);
    expect(new Set(operationIds).size).toBe(runtime.length);
  });

  it("documents current wire models and both tenant credentials", () => {
    const document = createOpenApiDocument({
      serverUrl: "https://api.example.test",
    });
    const schemas = document.components?.schemas as Record<string, any>;
    const securitySchemes = document.components?.securitySchemes as Record<
      string,
      any
    >;

    expect(schemas.Runtime.enum).toEqual([
      "claude-code",
      "codex",
      "pi-agent",
      "mock",
    ]);
    expect(schemas.Agent.properties).toHaveProperty("description");
    expect(schemas.Session.properties).toHaveProperty("title");
    expect(schemas.Session.properties).toHaveProperty("workspaceId");
    expect(schemas.ApiKeyInfo.properties).toHaveProperty("revokedAt");
    expect(document.paths?.["/v1/api-keys/{id}"]?.delete?.operationId).toBe(
      "revokeApiKey",
    );
    expect(
      document.paths?.["/v1/api-keys/{id}"]?.delete?.responses?.["200"]
        ?.content?.["application/json"]?.schema,
    ).toEqual({ $ref: "#/components/schemas/ApiKeyRevoked" });
    expect(document.paths?.["/v1/api-keys"]?.get?.responses).toHaveProperty("503");
    expect(document.paths?.["/v1/sessions/{id}/usage"]?.get?.responses).toHaveProperty("503");
    expect(securitySchemes.ApiKeyAuth).toMatchObject({
      type: "apiKey",
      in: "header",
      name: "x-api-key",
    });
    expect(securitySchemes.BearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
    });
    expect(document.security).toEqual([{ ApiKeyAuth: [] }, { BearerAuth: [] }]);
    expect(document.paths?.["/health"]?.get?.security).toEqual([]);
    expect(document.paths?.["/auth/login"]?.post?.security).toEqual([]);
    expect(document.paths?.["/auth/register"]?.post?.security).toEqual([]);
  });

  it("serves the full contract publicly from /openapi.json", async () => {
    process.env.AUTH_DISABLED = "false";
    const app = createApp({
      apiKeyStore: {
        async findByKeyHash() {
          throw new Error("the public OpenAPI endpoint must not authenticate");
        },
      },
    });

    const response = await app.request("/openapi.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(operationsOf(await response.json())).toEqual(runtimeOperations());
  });

  it("keeps the committed artifact byte-for-byte deterministic", async () => {
    const document = createOpenApiDocument({
      serverUrl: "http://localhost:3000",
    });
    const artifactPath = fileURLToPath(
      new URL("../../../../docs/openapi.json", import.meta.url),
    );
    const artifact = await readFile(artifactPath, "utf8");

    expect(artifact).toBe(serializeOpenApiDocument(document));
  });
});
