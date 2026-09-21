import { SHARE_READ_OPERATIONS } from "../lib/share-access.js";
import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import {
  DelegationListSchema,
  DelegationTraceSchema,
  DelegationUsageSchema,
  AgentFileListSchema,
  AgentFileNameSchema,
  AgentFileSchema,
  AgentListSchema,
  AgentSchema,
  ApiKeyCreateResultSchema,
  ApiKeyListSchema,
  ApiKeyRevokedSchema,
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
  SharedSessionSchema,
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
  WorkspaceFileReadSchema,
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
    ...(SHARE_READ_OPERATIONS.has(config.operationId ?? "") ? {
      security: config.security ?? [{ ApiKeyAuth: [] }, { BearerAuth: [] }, { SessionShareAuth: [] }],
      description: (config.description ?? "") + " Share access is limited to the linked Session or Workspace; SSE is forbidden. Every read rechecks Session and Workspace availability. History is shared verbatim, not redacted.",
    } : {}),
    responses: {
      ...config.responses,
      403: errorResponse("Share operation or resource denied"),
      ...(config.tags?.includes("Workspaces/Files") ? {
        503: errorResponse("Workspace storage is unavailable; saved files are retained"),
      } : {}),
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
  protectedRoute({
    method: "get", path: "/v1/shares/{id}", operationId: "resolveSessionShare",
    summary: "Resolve a live Session share", tags: ["Sessions"],
    description: "Requires x-session-share matching the URL ID. Checks the Session and bound Workspace still exist and are not deleted on every request. Share credentials take precedence over all ordinary credentials, including development auth bypass.",
    security: [{ SessionShareAuth: [] }], request: { params: idParams },
    responses: { 200: jsonResponse(z.object({ sessionId: z.string(), workspaceId: z.string() }), "Share scope"), 403: errorResponse("Share credential required"), 404: errorResponse("Share unavailable") },
  }),
  protectedRoute({
    method: "post", path: "/v1/sessions/{id}/share", operationId: "createSessionShare",
    summary: "Create or retrieve the Session's permanent share link", tags: ["Sessions"],
    description: "Owner credentials required. Returns the same 256-bit random ID on every call. Does not snapshot history or Workspace files. No expiry, rotation or revocation API.",
    request: { params: idParams },
    responses: { 200: jsonResponse(z.object({ id: z.string() }), "Share ID"), 404: errorResponse("Session or Workspace unavailable"), 503: errorResponse("Sharing unavailable") },
  }),
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
    description: "Returns the contract generated by the running server version. Responses may be cached for 300 seconds.",
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
    description: "Requires the deployment's invite code. Successful registration also logs in the User and returns a JWT valid for 30 days; send it as Authorization: Bearer <token> on /v1 requests.",
    tags: ["Authentication"],
    request: {
      body: jsonBody(
        z.object({
          username: z.string().regex(
            /^[a-zA-Z0-9_-]{3,32}$/,
            "Username must be 3–32 characters and contain only English letters, numbers, underscores (_) or hyphens (-). Periods (.) and spaces are not allowed.",
          ),
          password: z.string().min(8, "Password must be at least 8 characters."),
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
    description: "Returns a JWT valid for 30 days. Send it as Authorization: Bearer <token> on /v1 requests. API keys use the separate x-api-key header.",
    tags: ["Authentication"],
    request: {
      body: jsonBody(z.object({ username: z.string(), password: z.string() })),
    },
    responses: {
      200: jsonResponse(z.object({ token: z.string() }), "Login succeeded"),
      400: errorResponse("Invalid JSON body or missing username/password"),
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
    method: "post",
    path: "/v1/agents/{id}/fork",
    operationId: "forkAgent",
    summary: "Fork an Agent with independent Agent Files and Skills",
    description: "Copies configuration, Agent Files and the current contents of every Agent Skill into a new Agent. Sessions, Loops and Workspaces are not copied. Skill IDs and ownership are new; the original Library provenance is retained.",
    tags: ["Agents"],
    request: { params: idParams, body: jsonBody(z.object({ name: z.string().trim().min(1) })) },
    responses: {
      201: jsonResponse(AgentSchema, "Agent fork created"),
      400: errorResponse("Invalid fork name"),
      404: errorResponse("Agent not found"),
      500: errorResponse("Fork failed; cleanup of newly created resources was attempted"),
    },
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
    description: "Copies the Library Skill's current metadata and files into an independent Agent Skill. Re-equipping the same Library Skill returns the existing fork with 200; it does not refresh that fork from the Library. A name collision returns 409. Set overwrite=true after confirmation to replace the existing Agent Skill, including its complete file tree.",
    tags: ["Agents/Skills"],
    request: {
      params: idParams,
      body: jsonBody(z.object({ skillId: z.string(), overwrite: z.boolean().optional() })),
    },
    responses: {
      200: jsonResponse(SkillSchema, "Existing Skill Fork returned"),
      201: jsonResponse(SkillSchema, "Skill Fork created"),
      400: errorResponse("skillId is required"),
      409: errorResponse("Skill name conflict; confirm overwrite before retrying"),
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
      "paths is a JSON-encoded string array. Repeated files fields must have the same length and order as paths. Names are unique per owner. Conflicts return 409 before any writes; retry with overwrite=true after confirmation to replace the entire folder, retaining the Skill ID. For repeated names within one upload the last folder wins after confirmation.",
    tags: ["Skills"],
    request: {
      body: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: z.object({
              overwrite: z.enum(["true", "false"]).optional(),
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
      409: errorResponse("Skill name conflict; confirm overwrite before retrying"),
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
      409: errorResponse("Skill name already exists for this owner"),
      404: errorResponse("Skill not found"),
    },
  }),
  protectedRoute({
    method: "delete",
    path: "/v1/skills/{id}",
    operationId: "deleteSkill",
    summary: "Delete a Skill and its files",
    description: "Accepts a tenant-owned Library Skill or Agent Skill. Deleting a Library Skill preserves existing Agent forks. To remove an equipped Agent Skill together with its Agent reference, use DELETE /v1/agents/{id}/skills/{skillId}.",
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
    description:
      "Saving the root SKILL.md refreshes the Skill name and description. Edits preserve createdAt and advance updatedAt; editing an Agent Skill affects only its private copy.",
    tags: ["Skills/Files"],
    request: { params: idParams, body: jsonBody(SkillFileContentSchema) },
    responses: {
      409: errorResponse("Skill name already exists for this owner"),
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
    description: "Omit id to generate a new Workspace ID. A supplied ID must contain 1–128 ASCII letters, digits, underscores, or hyphens. Reusing an ID in this Tenant returns the existing Workspace with 201 and preserves its existing name.",
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
      409: errorResponse("Workspace has been deleted"),
    },
  }),
  protectedRoute({
    method: "get",
    path: "/v1/workspaces",
    operationId: "listWorkspaces",
    summary: "List Workspaces",
    description: "Returns all Workspaces owned by the Tenant, ordered by creation time ascending. This endpoint is not paginated.",
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
    method: "delete",
    path: "/v1/workspaces/{id}",
    operationId: "deleteWorkspace",
    summary: "Soft-delete a Workspace",
    description: "Marks the Workspace deleted. It and its Sessions disappear from lists; files, history, and running execution are retained.",
    tags: ["Workspaces"],
    request: { params: idParams },
    responses: {
      200: jsonResponse(DeletedSchema, "Workspace hidden"),
      404: errorResponse("Workspace not found"),
    },
  }),
  protectedRoute({
    method: "post",
    path: "/v1/sessions/{id}",
    operationId: "updateSession",
    summary: "Rename or soft-delete a Session",
    description: "A title renames the Session. deleted=true hides it from lists without terminating execution or deleting any history or files. The DELETE endpoint retains its separate execution-termination semantics.",
    tags: ["Sessions"],
    request: {
      params: idParams,
      body: jsonBody(z.union([
        z.object({ title: z.string().trim().min(1).max(500) }),
        z.object({ deleted: z.literal(true) }),
      ])),
    },
    responses: {
      200: jsonResponse(z.union([SessionSchema, DeletedSchema]), "Session renamed or hidden"),
      400: errorResponse("Invalid Session update"),
      404: errorResponse("Session not found"),
    },
  }),

  protectedRoute({
    method: "post",
    path: "/v1/sessions",
    operationId: "createSession",
    summary: "Create a Session",
    description: "Creates an idle Session for an Agent; send user.message to POST /v1/sessions/{id}/events to start a Turn. Omitting workspace_id creates a new Workspace. A supplied ID creates or reuses a Workspace in this Tenant and binds it permanently to this Session. Multiple Sessions may share that Workspace.",
    tags: ["Sessions"],
    request: {
      body: jsonBody(
        z.object({
          agent: z.string({ error: "Missing required field: agent" }).openapi({
            description: "ID of an Agent owned by the authenticated Tenant.",
            example: "agent_abc123",
          }),
          workspace_id: z
            .string({ error: "workspace_id must be a string" })
            .optional()
            .openapi({ description: "Optional Workspace ID: 1–128 ASCII letters, digits, underscores, or hyphens. Generated when omitted." }),
          workspace_name: z
            .string({ error: "workspace_name must be a string" })
            .optional()
            .openapi({ description: "Name for a newly created Workspace. Ignored when workspace_id already exists; use the Workspace update endpoint to rename it." }),
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
      409: errorResponse("Workspace has been deleted"),
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
        exclude_delegated: z
          .enum(["true", "false"], {
            error: "exclude_delegated must be true or false",
          })
          .optional()
          .openapi({
            param: { name: "exclude_delegated", in: "query" },
            description: "Set to true to exclude delegated child Sessions before pagination. Defaults to false.",
          }),
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
      200: jsonResponse(z.union([SessionSchema, SharedSessionSchema]), "Session found; share credentials receive display fields only"),
      404: errorResponse("Session not found"),
    },
  }),
  protectedRoute({
    method: "get",
    path: "/v1/sessions/{id}/usage",
    operationId: "getSessionUsage",
    summary: "Get a Session's recorded token usage",
    description:
      "Aggregates durable model-request usage recorded for the Session; it is not a per-token live counter. cache_hit_rate is cache_read_tokens / input_tokens and is null when input_tokens is zero.",
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
    description: "Permanently marks the Session terminated, stops its active execution, clears queued input, and releases its Sandbox. Retains the Session record, event history, and saved Workspace files. Further event submissions return 410. Use user.interrupt through POST /v1/sessions/{id}/events to stop only the active Turn while keeping the Session usable.",
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
      "Send user.message to start or continue Agent execution. user.message, user.tool_confirmation, and user.custom_tool_result are queued durably; 202 acknowledges acceptance, not Turn completion. user.define_outcome is stored directly and must be submitted alone. Queued and direct events cannot be mixed. user.interrupt must be the only event in its batch: it requests that the active Turn stop and leaves queued input eligible to run; requested reports whether a durable Interrupt command was accepted; interrupted remains false until an actual stop is observed through durable Turn events. Receive output through GET /v1/sessions/{id}/events with Accept: text/event-stream.",
    tags: ["Sessions/Events"],
    request: {
      params: idParams,
      body: jsonBody(z.object({ events: z.array(UserEventSchema).min(1) }).openapi({
        example: {
          events: [{ type: "user.message", data: { content: [{ type: "text", text: "Hello, agent!" }] } }],
        },
      })),
    },
    responses: {
      202: jsonResponse(
        z.object({
          accepted: z.literal(true),
          interrupted: z.boolean(),
          requested: z.boolean().optional(),
        }),
        "Events accepted",
      ),
      400: errorResponse("Invalid or unsupported event batch"),
      404: errorResponse("Session not found"),
      410: errorResponse("Session is terminated"),
    },
  }),
  protectedRoute({
    method: "get",
    path: "/v1/sessions/{id}/pending",
    operationId: "listPendingSessionEvents",
    summary: "Preview unclaimed queued input for a Session",
    description: "Returns at most 20 unclaimed entries. count is the page size; has_more reports additional queued input. The active Turn's claimed input is excluded.",
    tags: ["Sessions/Events"],
    request: { params: idParams },
    responses: {
      200: jsonResponse(z.object({
        count: z.number().int(), has_more: z.boolean(),
        data: z.array(z.object({ id: z.string(), type: z.string(), data: z.unknown(), arrived_at: z.string() })),
      }), "Queued input preview"),
      404: errorResponse("Session not found"),
    },
  }),
  protectedRoute({
    method: "get",
    path: "/v1/sessions/{id}/events",
    operationId: "listSessionEvents",
    summary: "List Complete Events or open an SSE stream",
    description:
      "Defaults to a JSON page of durable events. Send exactly Accept: text/event-stream for SSE. Last-Event-ID or replay=1 enables replay of durable events followed by buffered Deltas from the active Turn, then live delivery. include=chunks additionally forwards live Deltas. The SSE connection remains open across Turns; it does not close when a Turn finishes. JSON pagination parameters after_seq and limit do not control SSE replay.",
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
            description: "SSE only: replay durable events with seq greater than this value. Use 0 to replay from the beginning. A parseable value takes precedence over replay=1; an invalid value replays from the beginning.",
          }),
      }),
      query: z.object({
        after_seq: z
          .string()
          .optional()
          .openapi({
            type: "integer",
            param: { name: "after_seq", in: "query" },
            description: "JSON only: return events with seq greater than this value. Invalid values start from the beginning; continue with the last returned seq while has_more is true.",
          }),
        limit: z
          .string()
          .optional()
          .openapi({
            type: "integer",
            param: { name: "limit", in: "query" },
            description: "JSON only: defaults to 50 for omitted, invalid, or non-positive values. Positive values are parsed as integers; this endpoint does not apply the 100-item cap used by resource lists.",
          }),
        replay: z
          .string()
          .optional()
          .openapi({
            param: { name: "replay", in: "query" },
            description: "SSE only: set to 1 to replay from the beginning unless Last-Event-ID supplies a resume sequence.",
            example: "1",
          }),
        include: z
          .string()
          .optional()
          .openapi({
            param: { name: "include", in: "query" },
            description: "SSE only: set to chunks to receive live output Deltas. Buffered active-Turn Deltas are replayed independently of this flag when replay is requested.",
            example: "chunks",
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
                "Durable frames contain event, id (the event seq), and JSON data. Delta frames have no SSE id; their JSON data includes turnId and blockIndex. Streams also contain retry directives and keepalive comments, which are not events.",
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
    method: "put",
    path: "/v1/workspaces/{id}/files/content",
    operationId: "writeWorkspaceFile",
    summary: "Create or replace a Workspace text file",
    tags: ["Workspaces/Files"],
    request: {
      params: idParams,
      body: jsonBody(z.object({ path: z.string(), content: z.string() })),
    },
    responses: {
      200: jsonResponse(PathResultSchema, "Workspace file stored"),
      400: errorResponse("Invalid path or content"),
      404: errorResponse("Workspace not found"),
    },
  }),
  protectedRoute({
    method: "delete",
    path: "/v1/workspaces/{id}/files/content",
    operationId: "deleteWorkspaceFile",
    summary: "Delete a Workspace file",
    tags: ["Workspaces/Files"],
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
      404: errorResponse("Workspace or file not found"),
    },
  }),
  protectedRoute({
    method: "post",
    path: "/v1/workspaces/{id}/files/rename",
    operationId: "renameWorkspaceFile",
    summary: "Rename or move a Workspace file",
    description: "Copies the source to the destination and then deletes the source. An existing destination is overwritten; the operation is not atomic. Equal source and destination paths succeed without modification after the source is confirmed to exist.",
    tags: ["Workspaces/Files"],
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
    },
  }),
  protectedRoute({
    method: "post",
    path: "/v1/workspaces/{id}/files/upload",
    operationId: "uploadWorkspaceFiles",
    summary: "Upload Workspace files",
    description:
      "Upload one file field or repeated files fields, including binary media. For one file, path may name the exact target. Otherwise each uploaded filename is joined to destDir. Existing targets are overwritten. Files are written sequentially; a later failure does not roll back files already saved.",
    tags: ["Workspaces/Files"],
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
      404: errorResponse("Workspace not found"),
    },
  }),
  protectedRoute({
    method: "get",
    path: "/v1/workspaces/{id}/files",
    operationId: "listWorkspaceFiles",
    summary: "List Workspace files",
    description: "Returns a flat list of file paths and metadata from the authenticated Tenant's Workspace, including files saved by the Agent. Directory placeholders and the reserved .oma-workspace-checks subtree are omitted. This endpoint is not paginated.",
    tags: ["Workspaces/Files"],
    request: {
      params: idParams,
      query: z.object({
        prefix: z
          .string()
          .optional()
          .openapi({
            param: { name: "prefix", in: "query" },
            description: "Optional Workspace-relative directory subtree, for example renders or renders/. Omit to list the entire Workspace.",
          }),
      }),
    },
    responses: {
      200: jsonResponse(WorkspaceArtifactListSchema, "Workspace file metadata"),
      400: errorResponse("Invalid prefix"),
      404: errorResponse("Workspace not found"),
    },
  }),
  protectedRoute({
    method: "get",
    path: "/v1/workspaces/{id}/files/{path}",
    operationId: "getWorkspaceFile",
    summary: "Get a Workspace file read URL",
    description:
      "Returns JSON file metadata and a short-lived OSS read URL after Tenant authorization and a metadata-only existence check. Fetch url directly without API credentials; OSS serves file bytes with streaming and Range support. path is Workspace-relative; URI-encode each segment. Request a new URL when it expires. Use download=1 for a signed attachment filename. Browser reads require appropriate Bucket CORS. Regional OSS domains preserve stored MIME and may restrict previews; verify actual media behavior before choosing a custom domain.",
    tags: ["Workspaces/Files"],
    request: {
      params: z.object({
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
        path: z.string().openapi({
          param: { name: "path", in: "path" },
          example: "renders/preview.png",
        }),
      }),
      query: z.object({
        download: z.literal("1").optional().openapi({
          param: { name: "download", in: "query" },
          description: "Set to 1 to sign an attachment download with the original filename.",
        }),
        expiresIn: z.string().optional().openapi({
          type: "integer", param: { name: "expiresIn", in: "query" }, example: 600,
          description: "Defaults to 600 seconds when omitted or non-numeric. Finite values are truncated to an integer and clamped to 60–900 seconds.",
        }),
      }),
    },
    responses: {
      200: {
        ...jsonResponse(WorkspaceFileReadSchema, "File metadata and signed read URL"),
        headers: { "Cache-Control": { schema: { type: "string", example: "no-store" } } },
      },
      400: errorResponse("Invalid file path"),
      404: errorResponse("Workspace or file not found"),
      501: errorResponse("The configured Workspace backend does not support signed reads"),
    },
  }),
  ...[false, true].map((origin) => protectedRoute({
    method: "get",
    path: origin ? "/v1/sessions/{id}/delegation-origin" : "/v1/sessions/{id}/delegations",
    operationId: origin ? "getDelegationOrigin" : "listDelegations",
    summary: origin ? "Read child Session creation source and execution history" : "List this Session's delegated executions",
    tags: ["Sessions"],
    request: { params: idParams, query: z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), after_id: z.string().optional(), tool_use_id: z.string().optional(), turn_id: z.string().optional() }) },
    responses: { 200: jsonResponse(DelegationListSchema, "Persisted execution references and creation source"), 404: errorResponse("Session not found") },
  })),
  protectedRoute({
    method: "get", path: "/v1/sessions/{id}/delegations/{executionId}/events", operationId: "getDelegationTrace",
    summary: "Read one delegated execution's bounded trace and current Delta snapshot",
    description: "id must identify the execution's child or calling Session in the authenticated Tenant. Events and usage are scoped to this execution's Turn. Request subsequent pages with after_seq; the last page includes the active Turn's transient Delta snapshot. Poll from next_cursor to reconnect without loading any other execution's history.",
    tags: ["Sessions"],
    request: { params: z.object({ id: z.string(), executionId: z.string() }), query: z.object({ after_seq: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }) },
    responses: { 200: jsonResponse(DelegationTraceSchema, "Execution metadata, Complete Events, Delta projection and execution-only usage"), 404: errorResponse("Session or related execution not found") },
  }),
  protectedRoute({
    method: "get", path: "/v1/sessions/{id}/delegation-usage", operationId: "getDelegationUsage", summary: "Read Session and directly delegated usage separately", tags: ["Sessions"], request: { params: idParams },
    responses: { 200: jsonResponse(DelegationUsageSchema, "Disjoint Session and child execution model usage, plus their sum"), 404: errorResponse("Session not found") },
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
