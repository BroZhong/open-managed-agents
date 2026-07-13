import { z } from "@hono/zod-openapi";

export const DateTimeSchema = z.iso.datetime().openapi({
  description: "ISO 8601 timestamp",
  example: "2026-07-14T00:00:00.000Z",
});

export const ErrorSchema = z
  .object({
    error: z.string(),
    code: z.string().optional(),
  })
  .openapi("Error");

export const RuntimeSchema = z
  .enum(["claude-code", "codex", "pi-agent", "mock"])
  .openapi("Runtime");

export const ToolConfigSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    inputSchema: z.record(z.string(), z.unknown()),
  })
  .openapi("ToolConfig");

export const McpServerConfigSchema = z
  .object({
    name: z.string(),
    url: z.url(),
    transport: z.enum(["sse", "streamable-http"]).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .openapi("McpServerConfig");

export const AgentSandboxConfigSchema = z
  .object({
    enabled: z.boolean(),
    image: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .openapi("AgentSandboxConfig");

export const AgentSchema = z
  .object({
    id: z.string().openapi({ example: "agent_abc123" }),
    tenantId: z.string(),
    name: z.string(),
    description: z.string().optional(),
    model: z.string(),
    system: z.string(),
    runtime: RuntimeSchema,
    tools: z.array(ToolConfigSchema).optional(),
    mcpServers: z.array(McpServerConfigSchema).optional(),
    skills: z.array(z.string()).optional(),
    sandbox: AgentSandboxConfigSchema.optional(),
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
  })
  .openapi("Agent");

export const CreateAgentInputSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    model: z.string().min(1),
    system: z.string().min(1),
    runtime: RuntimeSchema,
    tools: z.array(ToolConfigSchema).optional(),
    mcpServers: z.array(McpServerConfigSchema).max(1).optional().openapi({
      description:
        "Only the Host-allowlisted rds-mcp configuration is accepted.",
    }),
    skills: z.array(z.string()).optional(),
    sandbox: AgentSandboxConfigSchema.optional(),
  })
  .openapi("CreateAgentInput");

export const UpdateAgentInputSchema =
  CreateAgentInputSchema.partial().openapi("UpdateAgentInput");

export const AgentListSchema = z
  .object({
    data: z.array(AgentSchema),
    has_more: z.boolean(),
    next_cursor: z.string().optional(),
  })
  .openapi("AgentList");

export const AgentFileNameSchema = z
  .enum(["IDENTITY", "SOUL", "USER", "MEMORY"])
  .openapi("AgentFileName");

export const AgentFileSummarySchema = z
  .object({
    filename: AgentFileNameSchema,
    updatedAt: DateTimeSchema,
  })
  .openapi("AgentFileSummary");

export const AgentFileSchema = AgentFileSummarySchema.extend({
  content: z.string(),
}).openapi("AgentFile");

export const AgentFileListSchema = z
  .object({
    data: z.array(AgentFileSummarySchema),
    has_more: z.literal(false),
  })
  .openapi("AgentFileList");

export const SkillOwnerTypeSchema = z
  .enum(["library", "agent"])
  .openapi("SkillOwnerType");

export const SkillSchema = z
  .object({
    id: z.string(),
    tenantId: z.string(),
    name: z.string(),
    description: z.string(),
    ownerType: SkillOwnerTypeSchema,
    ownerId: z.string(),
    sourceSkillId: z.string().nullable().optional(),
    updatedAt: DateTimeSchema,
  })
  .openapi("Skill");

export const SkillSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    updatedAt: DateTimeSchema,
  })
  .openapi("SkillSummary");

export const EquippedSkillSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    sourceSkillId: z.string().nullable(),
    updatedAt: DateTimeSchema,
  })
  .openapi("EquippedSkill");

export const SkillListSchema = z
  .object({
    data: z.array(SkillSummarySchema),
    has_more: z.boolean(),
    next_cursor: z.string().optional(),
  })
  .openapi("SkillList");

export const SkillDetailSchema = SkillSchema.extend({
  files: z.array(z.string()),
}).openapi("SkillDetail");

export const SkillFileListSchema = z
  .object({
    data: z.array(z.string()),
    has_more: z.literal(false),
  })
  .openapi("SkillFileList");

export const SkillFileContentSchema = z
  .object({
    path: z.string(),
    content: z.string(),
  })
  .openapi("SkillFileContent");

export const WorkspaceSchema = z
  .object({
    id: z.string(),
    tenantId: z.string(),
    name: z.string().optional(),
    createdAt: DateTimeSchema,
  })
  .openapi("Workspace");

export const WorkspaceListSchema = z
  .object({ data: z.array(WorkspaceSchema) })
  .openapi("WorkspaceList");

export const SessionStatusSchema = z
  .enum(["idle", "running", "terminated"])
  .openapi("SessionStatus");

export const SessionSchema = z
  .object({
    id: z.string().openapi({ example: "sess_abc123" }),
    tenantId: z.string(),
    agentId: z.string(),
    status: SessionStatusSchema,
    title: z.string().optional(),
    agent: AgentSchema,
    workspaceId: z.string(),
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
    terminatedAt: DateTimeSchema.optional(),
  })
  .openapi("Session");

export const SessionListSchema = z
  .object({
    data: z.array(SessionSchema),
    has_more: z.boolean(),
    next_cursor: z.string().optional(),
  })
  .openapi("SessionList");

export const TextBlockSchema = z
  .object({ type: z.literal("text"), text: z.string() })
  .openapi("TextBlock");

export const ImageBlockSchema = z
  .object({
    type: z.literal("image"),
    source: z.object({
      type: z.literal("base64"),
      mediaType: z.string(),
      data: z.string(),
    }),
  })
  .openapi("ImageBlock");

export const ContentBlockSchema = z
  .discriminatedUnion("type", [TextBlockSchema, ImageBlockSchema])
  .openapi("ContentBlock");

export const UserEventTypeSchema = z
  .enum([
    "user.message",
    "user.interrupt",
    "user.tool_confirmation",
    "user.custom_tool_result",
    "user.define_outcome",
  ])
  .openapi("UserEventType");

export const UserEventSchema = z
  .object({
    type: UserEventTypeSchema,
    data: z.unknown().openapi({ description: "Payload varies by event type." }),
  })
  .openapi("UserEvent");

export const StoredEventSchema = z
  .object({
    sessionId: z.string(),
    seq: z.number().int(),
    type: z.string(),
    data: z.unknown(),
    ts: DateTimeSchema,
    sessionThreadId: z.string(),
  })
  .openapi("StoredEvent");

export const EventListSchema = z
  .object({
    data: z.array(StoredEventSchema),
    has_more: z.boolean(),
  })
  .openapi("EventList");

export const TokenUsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cache_read_tokens: z.number().int().nonnegative(),
    cache_write_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
    cache_hit_rate: z.number().min(0).max(1).nullable().openapi({
      description:
        "cache_read_tokens / input_tokens; null when input_tokens is zero.",
    }),
  })
  .openapi("TokenUsage");

export const SessionUsageSchema = z
  .object({ usage: TokenUsageSchema })
  .openapi("SessionUsage");

const ApiKeyBaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  createdAt: DateTimeSchema,
});

export const ApiKeyInfoSchema = ApiKeyBaseSchema.extend({
  revokedAt: DateTimeSchema.nullable().openapi({
    description: "Revocation time, or null while the key is active.",
  }),
  usage: TokenUsageSchema,
}).openapi("ApiKeyInfo");

export const ApiKeyCreateResultSchema = ApiKeyBaseSchema.extend({
  key: z.string().openapi({
    description: "Raw key returned once at creation time. Store it securely.",
  }),
}).openapi("ApiKeyCreateResult");

export const ApiKeyListSchema = z
  .object({
    data: z.array(ApiKeyInfoSchema),
    has_more: z.literal(false),
  })
  .openapi("ApiKeyList");

export const ApiKeyRevokedSchema = z
  .object({ type: z.literal("api_key_revoked"), id: z.string() })
  .openapi("ApiKeyRevoked");

export const WorkspaceArtifactSchema = z
  .object({
    path: z.string(),
    size: z.number().int().nonnegative(),
    updated_at: DateTimeSchema.nullable(),
  })
  .openapi("WorkspaceArtifact");

export const WorkspaceArtifactListSchema = z
  .object({ data: z.array(WorkspaceArtifactSchema) })
  .openapi("WorkspaceArtifactList");

export const DeletedSchema = z
  .object({ type: z.string(), id: z.string() })
  .openapi("DeletedResource");

export const PathResultSchema = z
  .object({ path: z.string() })
  .openapi("PathResult");
