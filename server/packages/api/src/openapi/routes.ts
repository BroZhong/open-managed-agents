import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import {
  AgentFileListSchema,
  AgentFileNameSchema,
  AgentFileSchema,
  AgentListSchema,
  AgentSchema,
  ApiKeyCreateResultSchema,
  ApiKeyListSchema,
  ApiKeyRevokedSchema,
  ContentBlockSchema,
  CreateAgentInputSchema,
  CreateLoopInputSchema,
  DeletedSchema,
  EquippedSkillSchema,
  ErrorSchema,
  EventListSchema,
  LoopListSchema,
  LoopSchema,
  ManagedMcpCatalogSchema,
  PathResultSchema,
  SessionListSchema,
  SessionSchema,
  SessionStatusSchema,
  SessionUsageSchema,
  SkillDetailSchema,
  SkillFileContentSchema,
  SkillFileListSchema,
  SkillListSchema,
  SkillSchema,
  UpdateAgentInputSchema,
  UpdateLoopInputSchema,
  UserEventSchema,
  WorkspaceArtifactListSchema,
  WorkspaceListSchema,
  WorkspaceSchema,
} from "./schemas.js";

const jsonBody = (schema: z.ZodType, description?: string) => ({
  required: true,
  description,
  content: { "application/json": { schema } },
});

const jsonResponse = (schema: z.ZodType, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

const errorResponse = (description: string) =>
  jsonResponse(ErrorSchema, description);

function protectedRoute<const R extends RouteConfig>(config: R) {
  return createRoute({
    ...config,
    responses: {
      ...config.responses,
      401:
        config.responses[401] ??
        errorResponse("Missing or invalid tenant credential"),
    },
  });
}

function publicRoute<const R extends RouteConfig>(config: R) {
  return createRoute({ ...config, security: [] });
}

const idParams = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
});

const agentIdParams = z.object({
  agentId: z.string().openapi({ param: { name: "agentId", in: "path" } }),
});

const agentFileParams = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
  filename: z.string().openapi({
    param: { name: "filename", in: "path" },
  }),
});

const writableAgentFileParams = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
  filename: AgentFileNameSchema.openapi({
    param: { name: "filename", in: "path" },
  }),
});

const agentSkillParams = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
  skillId: z.string().openapi({ param: { name: "skillId", in: "path" } }),
});

const paginationQuery = z.object({
  // Keep the handlers' long-standing parseInt fallback behavior. The
  // OpenAPI override advertises the intended integer shape while runtime
  // validation remains tolerant of legacy values such as "abc" or "1.5".
  limit: z
    .string()
    .optional()
    .openapi({
      type: "integer",
      param: { name: "limit", in: "query" },
      example: 50,
      description:
        "Positive values are capped at 100; invalid or non-positive values use the default of 50.",
    }),
  cursor: z
    .string()
    .optional()
    .openapi({ param: { name: "cursor", in: "query" } }),
});

const pathQuery = z.object({
  path: z.string().openapi({
    param: { name: "path", in: "query" },
    example: "src/index.ts",
  }),
});

const binaryFileSchema = z
  .file()
  .openapi({ type: "string", format: "binary" });

const uploadedFilesSchema = z
  .union([binaryFileSchema, z.array(binaryFileSchema).min(1)])
  .openapi({
    type: "array",
    items: { type: "string", format: "binary" },
    minItems: 1,
  });

export type RegisteredOpenApiRoute = RouteConfig & {
  getRoutingPath(): string;
};

export const openApiRoutes: readonly RegisteredOpenApiRoute[] = [
  publicRoute({
    method: "get",
    path: "/health",
    operationId: "healthCheck",
    summary: "Health check",
    tags: ["System"],
    responses: {
      200: jsonResponse(
        z.object({ status: z.literal("ok") }),
        "Server is healthy",
      ),
    },
  }),
  publicRoute({
    method: "get",
    path: "/openapi.json",
    operationId: "getOpenApiDocument",
    summary: "Get the machine-readable OpenAPI contract",
    tags: ["System"],
    responses: {
      200: jsonResponse(
        z.record(z.string(), z.unknown()),
        "OpenAPI 3.1 document",
      ),
    },
  }),

  publicRoute({
    method: "post",
    path: "/auth/register",
    operationId: "registerUser",
    summary: "Register a User and create their Tenant",
    tags: ["Authentication"],
    request: {
      body: jsonBody(
        z.object({
          username: z.string().regex(/^[a-zA-Z0-9_-]{3,32}$/),
          password: z.string().min(8),
          inviteCode: z.string(),
        }),
      ),
    },
    responses: {
      200: jsonResponse(
        z.object({ token: z.string() }),
        "Registration succeeded",
      ),
      400: errorResponse("Invalid username or password"),
      403: errorResponse("Registration is closed or invite code is invalid"),
      409: errorResponse("Username is already taken"),
      503: errorResponse("Authentication is not configured"),
    },
  }),

  publicRoute({
    method: "post",
    path: "/auth/login",
    operationId: "loginUser",
    summary: "Log in and issue a Tenant session token",
    tags: ["Authentication"],
    request: {
      body: jsonBody(z.object({ username: z.string(), password: z.string() })),
    },
    responses: {
      200: jsonResponse(z.object({ token: z.string() }), "Login succeeded"),
      401: errorResponse("Invalid credentials"),
      503: errorResponse("Authentication is not configured"),
    },
  }),

  protectedRoute({
    method: "get",
    path: "/v1/mcp-catalog",
    operationId: "listManagedMcpCatalog",
    summary: "List Host-managed MCP catalog entries",
    description:
      "Returns safe metadata for MCP servers that may be equipped on an Agent. Runtime endpoints, commands, headers, and credentials are never exposed.",
    tags: ["MCP Catalog"],
    responses: {
      200: jsonResponse(ManagedMcpCatalogSchema, "Managed MCP catalog"),
    },
  }),

  protectedRoute({
    method: "post",
    path: "/v1/agents",
    operationId: "createAgent",
    summary: "Create an Agent",
    tags: ["Agents"],
    request: { body: jsonBody(CreateAgentInputSchema) },
    responses: {
      201: jsonResponse(AgentSchema, "Agent created"),
      400: errorResponse("Invalid Agent configuration"),
    },
  }),
  protectedRoute({
    method: "get",
    path: "/v1/agents",
    operationId: "listAgents",
    summary: "List Agents",
    tags: ["Agents"],
    request: { query: paginationQuery },
    responses: { 200: jsonResponse(AgentListSchema, "Paginated Agent list") },
  }),
  protectedRoute({
    method: "get",
    path: "/v1/agents/{id}",
    operationId: "getAgent",
    summary: "Get an Agent",
    tags: ["Agents"],
    request: { params: idParams },
    responses: {
      200: jsonResponse(AgentSchema, "Agent found"),
      404: errorResponse("Agent not found"),
    },
  }),
  protectedRoute({
    method: "post",
    path: "/v1/agents/{id}",
    operationId: "updateAgent",
    summary: "Update an Agent",
    tags: ["Agents"],
    request: { params: idParams, body: jsonBody(UpdateAgentInputSchema) },
    responses: {
      200: jsonResponse(AgentSchema, "Agent updated"),
      400: errorResponse("Invalid Agent configuration"),
      404: errorResponse("Agent not found"),
    },
  }),
  protectedRoute({
    method: "delete",
    path: "/v1/agents/{id}",
    operationId: "deleteAgent",
    summary: "Delete an Agent",
    tags: ["Agents"],
    request: { params: idParams },
    responses: {
      200: jsonResponse(DeletedSchema, "Agent deleted"),
      404: errorResponse("Agent not found"),
    },
  }),

  protectedRoute({
    method: "get",
    path: "/v1/agents/{agentId}/loops",
    operationId: "listAgentLoops",
    summary: "List an Agent's Loops",
    tags: ["Loops"],
    request: { params: agentIdParams },
    responses: {
      200: jsonResponse(LoopListSchema, "Agent Loops"),
      404: errorResponse("Agent not found"),
    },
  }),
  protectedRoute({
    method: "post",
    path: "/v1/agents/{agentId}/loops",
    operationId: "createAgentLoop",
    summary: "Create a Loop for an Agent",
    tags: ["Loops"],
    request: {
      params: agentIdParams,
      body: jsonBody(CreateLoopInputSchema),
    },
    responses: {
      201: jsonResponse(LoopSchema, "Loop created"),
      400: errorResponse("Invalid Loop configuration"),
      404: errorResponse("Agent not found"),
    },
  }),
  protectedRoute({
    method: "get",
    path: "/v1/loops/{id}",
    operationId: "getLoop",
    summary: "Get a Loop",
    tags: ["Loops"],
    request: { params: idParams },
    responses: {
      200: jsonResponse(LoopSchema, "Loop found"),
      404: errorResponse("Loop not found"),
    },
  }),
  protectedRoute({
    method: "post",
    path: "/v1/loops/{id}",
    operationId: "updateLoop",
    summary: "Update a Loop",
    tags: ["Loops"],
    request: {
      params: idParams,
      body: jsonBody(UpdateLoopInputSchema),
    },
    responses: {
      200: jsonResponse(LoopSchema, "Loop updated"),
      400: errorResponse("Invalid Loop configuration"),
      404: errorResponse("Loop not found"),
    },
  }),
  protectedRoute({
    method: "post",
    path: "/v1/loops/{id}/run",
    operationId: "runLoop",
    summary: "Run a Loop immediately",
    description:
      "Creates a Loop-owned Session immediately without changing the Loop's regular schedule.",
    tags: ["Loops"],
    request: { params: idParams },
    responses: {
      201: jsonResponse(SessionSchema, "Loop Session created"),
      404: errorResponse("Loop not found"),
    },
  }),

  protectedRoute({
    method: "get",
    path: "/v1/agents/{id}/files",
    operationId: "listAgentFiles",
    summary: "List an Agent's Files",
    tags: ["Agents/Files"],
    request: { params: idParams },
    responses: {
      200: jsonResponse(AgentFileListSchema, "Agent File metadata"),
      404: errorResponse("Agent not found"),
    },
  }),
  protectedRoute({
    method: "get",
    path: "/v1/agents/{id}/files/{filename}",
    operationId: "getAgentFile",
    summary: "Read an Agent File",
    tags: ["Agents/Files"],
    request: { params: agentFileParams },
    responses: {
      200: jsonResponse(AgentFileSchema, "Agent File content"),
      404: errorResponse("Agent or Agent File not found"),
    },
  }),
  protectedRoute({
    method: "post",
    path: "/v1/agents/{id}/files/{filename}",
    operationId: "upsertAgentFile",
    summary: "Create or replace an Agent File",
    tags: ["Agents/Files"],
    request: {
      params: writableAgentFileParams,
      body: jsonBody(z.object({ content: z.string() })),
    },
    responses: {
      200: jsonResponse(AgentFileSchema, "Agent File stored"),
      400: errorResponse("Invalid Agent File name or content"),
      404: errorResponse("Agent not found"),
    },
  }),
  protectedRoute({
    method: "delete",
    path: "/v1/agents/{id}/files/{filename}",
    operationId: "deleteAgentFile",
    summary: "Delete an Agent File",
    tags: ["Agents/Files"],
    request: { params: agentFileParams },
    responses: {
      200: jsonResponse(
        z.object({
          type: z.literal("agent_file_deleted"),
          agentId: z.string(),
          filename: AgentFileNameSchema,
        }),
        "Agent File deleted",
      ),
      404: errorResponse("Agent or Agent File not found"),
    },
  }),

  protectedRoute({
    method: "get",
    path: "/v1/agents/{id}/skills",
    operationId: "listAgentSkills",
    summary: "List an Agent's equipped Skill Forks",
    tags: ["Agents/Skills"],
    request: { params: idParams },
    responses: {
      200: jsonResponse(
        z.object({
          data: z.array(EquippedSkillSchema),
          has_more: z.literal(false),
        }),
        "Equipped Skill Forks",
      ),
      404: errorResponse("Agent not found"),
    },
  }),
  protectedRoute({
    method: "post",
    path: "/v1/agents/{id}/skills",
    operationId: "equipAgentSkill",
    summary: "Equip a Library Skill by creating a Skill Fork",
    tags: ["Agents/Skills"],
    request: {
      params: idParams,
      body: jsonBody(z.object({ skillId: z.string() })),
    },
    responses: {
      200: jsonResponse(SkillSchema, "Existing Skill Fork returned"),
      201: jsonResponse(SkillSchema, "Skill Fork created"),
      400: errorResponse("skillId is required"),
      404: errorResponse("Agent or Library Skill not found"),
    },
  }),
  protectedRoute({
    method: "delete",
    path: "/v1/agents/{id}/skills/{skillId}",
    operationId: "unequipAgentSkill",
    summary: "Unequip and delete an Agent's Skill Fork",
    tags: ["Agents/Skills"],
    request: { params: agentSkillParams },
    responses: {
      200: jsonResponse(
        z.object({
          type: z.literal("skill_unequipped"),
          agentId: z.string(),
          skillId: z.string(),
        }),
        "Skill unequipped",
      ),
      404: errorResponse("Agent or Skill Fork not found"),
    },
  }),

  protectedRoute({
    method: "post",
    path: "/v1/skills",
    operationId: "uploadSkills",
    summary: "Upload one or more Library Skills",
    description:
      "paths is a JSON-encoded string array. Repeated files fields must have the same length and order as paths.",
    tags: ["Skills"],
    request: {
      body: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: z.object({
              paths: z.string().openapi({ example: '["my-skill/SKILL.md"]' }),
              files: uploadedFilesSchema,
            }),
          },
        },
      },
    },
    responses: {
      201: jsonResponse(
        z.object({ data: z.array(SkillSchema) }),
        "Library Skills created",
      ),
      400: errorResponse("Invalid multipart Skill tree"),
    },
  }),
  protectedRoute({
    method: "get",
    path: "/v1/skills",
    operationId: "listSkills",
    summary: "List Library Skills",
    tags: ["Skills"],
    request: { query: paginationQuery },
    responses: {
      200: jsonResponse(SkillListSchema, "Paginated Library Skill list"),
    },
  }),
  protectedRoute({
    method: "get",
    path: "/v1/skills/{id}",
    operationId: "getSkill",
    summary: "Get Skill metadata and file paths",
    tags: ["Skills"],
    request: { params: idParams },
    responses: {
      200: jsonResponse(SkillDetailSchema, "Skill found"),
      404: errorResponse("Skill not found"),
    },
  }),
  protectedRoute({
    method: "post",
    path: "/v1/skills/{id}",
    operationId: "updateSkill",
    summary: "Update Skill metadata",
    tags: ["Skills"],
    request: {
      params: idParams,
      body: jsonBody(
        z.object({
          name: z.string().optional(),
          description: z.string().optional(),
        }),
      ),
    },
    responses: {
      200: jsonResponse(SkillSchema, "Skill updated"),
      400: errorResponse("Invalid Skill metadata"),
      404: errorResponse("Skill not found"),
    },
  }),
  protectedRoute({
    method: "delete",
    path: "/v1/skills/{id}",
    operationId: "deleteSkill",
    summary: "Delete a Library Skill",
    tags: ["Skills"],
    request: { params: idParams },
    responses: {
      200: jsonResponse(DeletedSchema, "Skill deleted"),
      404: errorResponse("Skill not found"),
    },
  }),
  protectedRoute({
    method: "get",
    path: "/v1/skills/{id}/files",
    operationId: "listSkillFiles",
    summary: "List a Skill's file paths",
    tags: ["Skills/Files"],
    request: { params: idParams },
    responses: {
      200: jsonResponse(SkillFileListSchema, "Skill file paths"),
      404: errorResponse("Skill not found"),
    },
  }),
  protectedRoute({
    method: "get",
    path: "/v1/skills/{id}/files/content",
    operationId: "getSkillFileContent",
    summary: "Read a Skill text file",
    tags: ["Skills/Files"],
    request: { params: idParams, query: pathQuery },
    responses: {
      200: jsonResponse(SkillFileContentSchema, "Skill file content"),
      400: errorResponse("Invalid or missing path"),
      404: errorResponse("Skill or file not found"),
    },
  }),
  protectedRoute({
    method: "put",
    path: "/v1/skills/{id}/files/content",
    operationId: "putSkillFileContent",
    summary: "Create or replace a Skill text file",
    tags: ["Skills/Files"],
    request: { params: idParams, body: jsonBody(SkillFileContentSchema) },
    responses: {
      200: jsonResponse(SkillFileContentSchema, "Skill file stored"),
      400: errorResponse("Invalid path or content"),
      404: errorResponse("Skill not found"),
    },
  }),
  protectedRoute({
    method: "delete",
    path: "/v1/skills/{id}/files/content",
    operationId: "deleteSkillFileContent",
    summary: "Delete a Skill file",
    tags: ["Skills/Files"],
    request: { params: idParams, query: pathQuery },
    responses: {
      200: jsonResponse(
        z.object({
          type: z.literal("skill_file_deleted"),
          id: z.string(),
          path: z.string(),
        }),
        "Skill file deleted",
      ),
      400: errorResponse("Invalid or missing path"),
      404: errorResponse("Skill not found"),
    },
  }),
  protectedRoute({
    method: "post",
    path: "/v1/skills/{id}/files/rename",
    operationId: "renameSkillFile",
    summary: "Rename or move a Skill file",
    tags: ["Skills/Files"],
    request: {
      params: idParams,
      body: jsonBody(z.object({ from: z.string(), to: z.string() })),
    },
    responses: {
      200: jsonResponse(
        z.object({
          type: z.literal("skill_file_renamed"),
          id: z.string(),
          from: z.string(),
          to: z.string(),
        }),
        "Skill file renamed",
      ),
      400: errorResponse("Invalid source or destination path"),
      404: errorResponse("Skill or source file not found"),
    },
  }),

  protectedRoute({
    method: "get",
    path: "/v1/api-keys",
    operationId: "listApiKeys",
    summary: "List API keys and their token usage",
    tags: ["API Keys"],
    responses: {
      200: jsonResponse(ApiKeyListSchema, "API keys with cumulative usage"),
      503: errorResponse("Token usage service is unavailable"),
    },
  }),
  protectedRoute({
    method: "post",
    path: "/v1/api-keys",
    operationId: "createApiKey",
    summary: "Create an API key",
    description: "The raw key is returned only once.",
    tags: ["API Keys"],
    request: {
      body: jsonBody(
        z.object({
          name: z
            .string({ error: "name is required" })
            .min(1, { error: "name is required" }),
        }),
      ),
    },
    responses: {
      201: jsonResponse(ApiKeyCreateResultSchema, "API key created"),
      400: errorResponse("Invalid key name"),
    },
  }),
  protectedRoute({
    method: "delete",
    path: "/v1/api-keys/{id}",
    operationId: "revokeApiKey",
    summary: "Revoke an API key",
    description:
      "Stops authentication immediately while retaining the key identity and historical token usage for auditability.",
    tags: ["API Keys"],
    request: { params: idParams },
    responses: {
      200: jsonResponse(ApiKeyRevokedSchema, "API key revoked"),
      404: errorResponse("API key not found"),
    },
  }),

  protectedRoute({
    method: "post",
    path: "/v1/workspaces",
    operationId: "createWorkspace",
    summary: "Create or idempotently return a Workspace",
    tags: ["Workspaces"],
    request: {
      body: jsonBody(
        z.object({
          id: z.string().optional(),
          workspaceId: z.string().optional().openapi({ deprecated: true }),
          name: z.string({ error: "name must be a string" }).optional(),
        }),
      ),
    },
    responses: {
      201: jsonResponse(WorkspaceSchema, "Workspace created or returned"),
      400: errorResponse("Invalid Workspace metadata"),
    },
  }),
  protectedRoute({
    method: "get",
    path: "/v1/workspaces",
    operationId: "listWorkspaces",
    summary: "List Workspaces",
    tags: ["Workspaces"],
    responses: { 200: jsonResponse(WorkspaceListSchema, "Tenant Workspaces") },
  }),
  protectedRoute({
    method: "get",
    path: "/v1/workspaces/{id}",
    operationId: "getWorkspace",
    summary: "Get a Workspace",
    tags: ["Workspaces"],
    request: { params: idParams },
    responses: {
      200: jsonResponse(WorkspaceSchema, "Workspace found"),
      404: errorResponse("Workspace not found"),
    },
  }),
  protectedRoute({
    method: "post",
    path: "/v1/workspaces/{id}",
    operationId: "updateWorkspace",
    summary: "Rename a Workspace",
    tags: ["Workspaces"],
    request: {
      params: idParams,
      body: jsonBody(
        z.object({
          name: z.string({ error: "name must be a string" }).optional(),
        }),
      ),
    },
    responses: {
      200: jsonResponse(WorkspaceSchema, "Workspace updated"),
      400: errorResponse("Invalid Workspace name"),
      404: errorResponse("Workspace not found"),
    },
  }),

  protectedRoute({
    method: "post",
    path: "/v1/sessions",
    operationId: "createSession",
    summary: "Create a Session",
    tags: ["Sessions"],
    request: {
      body: jsonBody(
        z.object({
          agent: z.string({ error: "Missing required field: agent" }),
          workspace_id: z
            .string({ error: "workspace_id must be a string" })
            .optional(),
          workspace_name: z
            .string({ error: "workspace_name must be a string" })
            .optional(),
          workspaceId: z
            .string({ error: "workspace_id must be a string" })
            .optional()
            .openapi({ deprecated: true }),
          workspaceName: z
            .string({ error: "workspace_name must be a string" })
            .optional()
            .openapi({ deprecated: true }),
        }),
      ),
    },
    responses: {
      201: jsonResponse(SessionSchema, "Session created"),
      400: errorResponse("Invalid Session input"),
      404: errorResponse("Agent not found"),
    },
  }),
  protectedRoute({
    method: "get",
    path: "/v1/sessions",
    operationId: "listSessions",
    summary: "List Sessions",
    tags: ["Sessions"],
    request: {
      query: paginationQuery.extend({
        agent_id: z
          .string()
          .optional()
          .openapi({ param: { name: "agent_id", in: "query" } }),
        loop_id: z
          .string()
          .optional()
          .openapi({ param: { name: "loop_id", in: "query" } }),
        exclude_loop: z
          .enum(["true", "false"], {
            error: "exclude_loop must be true or false",
          })
          .optional()
          .openapi({
            param: { name: "exclude_loop", in: "query" },
            description:
              "Set to true to exclude Loop-owned Sessions. Cannot be combined with loop_id.",
          }),
        status: SessionStatusSchema.optional().openapi({
          param: { name: "status", in: "query" },
        }),
      }),
    },
    responses: {
      200: jsonResponse(SessionListSchema, "Paginated Session list"),
      400: errorResponse("Invalid Session list filters"),
    },
  }),
  protectedRoute({
    method: "get",
    path: "/v1/sessions/{id}",
    operationId: "getSession",
    summary: "Get a Session",
    tags: ["Sessions"],
    request: { params: idParams },
    responses: {
      200: jsonResponse(SessionSchema, "Session found"),
      404: errorResponse("Session not found"),
    },
  }),
  protectedRoute({
    method: "get",
    path: "/v1/sessions/{id}/usage",
    operationId: "getSessionUsage",
    summary: "Get a Session's live token usage",
    description:
      "Aggregates durable model-request usage for the Session. cache_hit_rate is cache_read_tokens / input_tokens and is null when input_tokens is zero.",
    tags: ["Sessions/Usage"],
    request: { params: idParams },
    responses: {
      200: jsonResponse(SessionUsageSchema, "Current Session token usage"),
      404: errorResponse("Session not found"),
      503: errorResponse("Token usage service is unavailable"),
    },
  }),
  protectedRoute({
    method: "delete",
    path: "/v1/sessions/{id}",
    operationId: "terminateSession",
    summary: "Terminate a Session",
    tags: ["Sessions"],
    request: { params: idParams },
    responses: {
      200: jsonResponse(DeletedSchema, "Session terminated"),
      404: errorResponse("Session not found"),
    },
  }),

  protectedRoute({
    method: "post",
    path: "/v1/sessions/{id}/events",
    operationId: "appendSessionEvents",
    summary: "Append User events to a Session",
    description:
      "Queued and direct events cannot be mixed. user.interrupt must be the only event in its batch. Every accepted batch returns the same acknowledgement shape; interrupted is true only for user.interrupt.",
    tags: ["Sessions/Events"],
    request: {
      params: idParams,
      headers: z.object({
        "X-VFS-Token": z
          .string()
          .max(8192)
          .optional()
          .openapi({
            description:
              "Transient VFS access token stored out-of-band for the queued event and exposed only to a direct vfs-cli subprocess. It is not persisted in the event log, Agent, Workspace, or sandbox environment.",
            param: { name: "X-VFS-Token", in: "header" },
          }),
      }),
      body: jsonBody(z.object({ events: z.array(UserEventSchema).min(1) })),
    },
    responses: {
      202: jsonResponse(
        z.object({
          accepted: z.literal(true),
          interrupted: z.boolean(),
        }),
        "Events accepted",
      ),
      400: errorResponse("Invalid or unsupported event batch"),
      503: errorResponse("Transient VFS credential store unavailable"),
      404: errorResponse("Session not found"),
      410: errorResponse("Session is terminated"),
    },
  }),
  protectedRoute({
    method: "get",
    path: "/v1/sessions/{id}/events",
    operationId: "listSessionEvents",
    summary: "List Complete Events or open an SSE stream",
    description:
      "Send Accept: text/event-stream for live delivery. Last-Event-ID or replay=1 enables durable replay; include=chunks includes live Deltas.",
    tags: ["Sessions/Events"],
    request: {
      params: idParams,
      headers: z.object({
        Accept: z
          .string()
          .optional()
          .openapi({
            param: { name: "Accept", in: "header" },
          }),
        "Last-Event-ID": z
          .string()
          .optional()
          .openapi({
            param: { name: "Last-Event-ID", in: "header" },
          }),
      }),
      query: z.object({
        after_seq: z
          .string()
          .optional()
          .openapi({
            type: "integer",
            param: { name: "after_seq", in: "query" },
          }),
        limit: z
          .string()
          .optional()
          .openapi({
            type: "integer",
            param: { name: "limit", in: "query" },
          }),
        replay: z
          .string()
          .optional()
          .openapi({ param: { name: "replay", in: "query" } }),
        include: z
          .string()
          .optional()
          .openapi({
            param: { name: "include", in: "query" },
          }),
      }),
    },
    responses: {
      200: {
        description: "Complete Event page or Server-Sent Event stream",
        headers: {
          "Cache-Control": { schema: { type: "string" } },
          "X-Accel-Buffering": { schema: { type: "string" } },
        },
        content: {
          "application/json": { schema: EventListSchema },
          "text/event-stream": {
            schema: z.string().openapi({
              description:
                "SSE frames containing event, id, and JSON data fields.",
              example:
                'event: agent.message\nid: 42\ndata: {"content":[{"type":"text","text":"Hello"}]}\n\n',
            }),
          },
        },
      },
      404: errorResponse("Session not found"),
    },
  }),
  protectedRoute({
    method: "post",
    path: "/v1/sessions/{id}/messages",
    operationId: "sendSessionMessage",
    summary: "Send a message and stream the Turn response",
    description:
      "Legacy same-request SSE interface. New clients should append user.message through /events.",
    deprecated: true,
    tags: ["Sessions/Messages"],
    request: {
      params: idParams,
      body: jsonBody(
        z.object({
          content: z.union([
            z.string().min(1),
            z.array(ContentBlockSchema).min(1),
          ]),
        }),
      ),
    },
    responses: {
      200: {
        description: "Server-Sent Event stream for this Turn",
        content: {
          "text/event-stream": {
            schema: z
              .string()
              .openapi({ description: "SSE frames for the Turn." }),
          },
        },
      },
      400: errorResponse("Message content is empty or invalid"),
      404: errorResponse("Session not found"),
      410: errorResponse("Session is terminated"),
    },
  }),

  protectedRoute({
    method: "put",
    path: "/v1/sessions/{id}/workspace/files/content",
    operationId: "writeWorkspaceFile",
    summary: "Create or replace a Workspace text file",
    tags: ["Sessions/Workspace Files"],
    request: {
      params: idParams,
      body: jsonBody(z.object({ path: z.string(), content: z.string() })),
    },
    responses: {
      200: jsonResponse(PathResultSchema, "Workspace file stored"),
      400: errorResponse("Invalid path or content"),
      404: errorResponse("Session not found"),
      423: errorResponse("Workspace is locked while the Agent is running"),
    },
  }),
  protectedRoute({
    method: "delete",
    path: "/v1/sessions/{id}/workspace/files/content",
    operationId: "deleteWorkspaceFile",
    summary: "Delete a Workspace file",
    tags: ["Sessions/Workspace Files"],
    request: { params: idParams, query: pathQuery },
    responses: {
      200: jsonResponse(
        z.object({
          type: z.literal("workspace_file_deleted"),
          path: z.string(),
        }),
        "Workspace file deleted",
      ),
      400: errorResponse("Invalid or missing path"),
      404: errorResponse("Session or file not found"),
      423: errorResponse("Workspace is locked while the Agent is running"),
    },
  }),
  protectedRoute({
    method: "post",
    path: "/v1/sessions/{id}/workspace/files/rename",
    operationId: "renameWorkspaceFile",
    summary: "Rename or move a Workspace file",
    tags: ["Sessions/Workspace Files"],
    request: {
      params: idParams,
      body: jsonBody(z.object({ from: z.string(), to: z.string() })),
    },
    responses: {
      200: jsonResponse(
        z.object({
          type: z.literal("workspace_file_renamed"),
          from: z.string(),
          to: z.string(),
        }),
        "Workspace file renamed",
      ),
      400: errorResponse("Invalid source or destination path"),
      404: errorResponse("Session or source file not found"),
      423: errorResponse("Workspace is locked while the Agent is running"),
    },
  }),
  protectedRoute({
    method: "post",
    path: "/v1/sessions/{id}/workspace/files/upload",
    operationId: "uploadWorkspaceFiles",
    summary: "Upload Workspace files",
    description:
      "For one file, path may name the exact target. Otherwise each uploaded filename is joined to destDir.",
    tags: ["Sessions/Workspace Files"],
    request: {
      params: idParams,
      body: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: z.union([
              z.object({
                file: binaryFileSchema,
                path: z.string().optional(),
                destDir: z.string().optional(),
              }),
              z.object({
                files: uploadedFilesSchema,
                path: z.string().optional(),
                destDir: z.string().optional(),
              }),
            ]),
          },
        },
      },
    },
    responses: {
      200: jsonResponse(
        z.object({ data: z.array(PathResultSchema) }),
        "Uploaded file paths",
      ),
      400: errorResponse("Invalid multipart body or target path"),
      404: errorResponse("Session not found"),
      423: errorResponse("Workspace is locked while the Agent is running"),
    },
  }),
  protectedRoute({
    method: "get",
    path: "/v1/sessions/{id}/workspace/preview-url",
    operationId: "createWorkspacePreviewUrl",
    summary: "Create a signed Workspace file preview URL",
    tags: ["Sessions/Workspace Files"],
    request: {
      params: idParams,
      query: pathQuery.extend({
        expiresIn: z
          .string()
          .optional()
          .openapi({
            type: "integer",
            param: { name: "expiresIn", in: "query" },
            example: 600,
            description: "Clamped to the inclusive range 60–900 seconds.",
          }),
      }),
    },
    responses: {
      200: jsonResponse(
        z.object({ url: z.url(), expiresIn: z.number().int() }),
        "Signed read URL",
      ),
      400: errorResponse("Invalid path"),
      404: errorResponse("Session or file not found"),
      501: errorResponse(
        "Storage adapter cannot create a reachable signed URL",
      ),
    },
  }),
  protectedRoute({
    method: "get",
    path: "/v1/sessions/{id}/workspace/files",
    operationId: "listWorkspaceFiles",
    summary: "List Workspace files",
    tags: ["Sessions/Workspace Files"],
    request: {
      params: idParams,
      query: z.object({
        prefix: z
          .string()
          .optional()
          .openapi({ param: { name: "prefix", in: "query" } }),
      }),
    },
    responses: {
      200: jsonResponse(WorkspaceArtifactListSchema, "Workspace file metadata"),
      400: errorResponse("Invalid prefix"),
      404: errorResponse("Session not found"),
    },
  }),
  protectedRoute({
    method: "get",
    path: "/v1/sessions/{id}/workspace/files/{path}",
    operationId: "getWorkspaceFile",
    summary: "Preview or download a Workspace file",
    description:
      "path is a greedy Workspace-relative path and may contain '/'. The Hono runtime adapts this OpenAPI path template to its wildcard route.",
    tags: ["Sessions/Workspace Files"],
    request: {
      params: z.object({
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
        path: z.string().openapi({
          param: { name: "path", in: "path" },
          example: "renders/preview.png",
        }),
      }),
      query: z.object({
        download: z
          .literal("1")
          .optional()
          .openapi({
            param: { name: "download", in: "query" },
          }),
      }),
    },
    responses: {
      200: {
        description:
          "File bytes; the actual Content-Type is the stored media type",
        headers: {
          "Content-Disposition": { schema: { type: "string" } },
          "Content-Length": { schema: { type: "integer" } },
          "Cache-Control": { schema: { type: "string" } },
        },
        content: { "application/octet-stream": { schema: binaryFileSchema } },
      },
      400: errorResponse("Invalid file path"),
      404: errorResponse("Session or file not found"),
    },
  }),
] as const;

export function getOpenApiRoute(
  operationId: string,
): RegisteredOpenApiRoute {
  const route = openApiRoutes.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (!route) {
    throw new Error(`Unknown OpenAPI operation: ${operationId}`);
  }
  return route;
}
