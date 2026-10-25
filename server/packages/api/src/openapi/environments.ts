import { createRoute, z } from "@hono/zod-openapi";
import { ENVIRONMENT_BASE_IMAGES } from "@oma-server/store";
import { ENVIRONMENT_ENV_MAX_BYTES } from "../lib/environments.js";
import { DateTimeSchema, DeletedSchema, ErrorSchema } from "./schemas.js";

const text = (field: string, max: number) => z.string().max(max, { error: `${field} must be at most ${max} characters` })
  .refine((value) => !value.includes("\0"), { error: `${field} must not contain NUL characters` });

const NameSchema = z.string().trim().min(1, { error: "name must not be empty" }).max(100, { error: "name must be at most 100 characters" })
  .refine((value) => !/[\0-\x1f\x7f]/.test(value), { error: "name must not contain control characters" });
const BaseImageSchema = z.enum(ENVIRONMENT_BASE_IMAGES, { error: `baseImage must be one of: ${ENVIRONMENT_BASE_IMAGES.join(", ")}` })
  .openapi("EnvironmentBaseImage", { description: "oma-base: Node 22, the Pi tool runtime, rg/fd and Aliyun mirrors; oma-media adds FFmpeg and CJK fonts." });
const VariableNameSchema = z.string().min(1).max(128).openapi({ description: "A shell variable name, ^[A-Za-z_][A-Za-z0-9_]*$. System-reserved names are rejected with environment_env_reserved." });
const SecretSourceSchema = z.enum(["platform", "environment"], { error: "secretRef.source must be platform or environment (vault is reserved)" });
const SecretRefSchema = z.object({ source: SecretSourceSchema, key: z.string().min(1).max(128) }).strict();

const PlainVariableSchema = z.object({ name: VariableNameSchema, value: text("value", ENVIRONMENT_ENV_MAX_BYTES) }).strict();
export const EnvironmentVariableSchema = z.union([
  PlainVariableSchema,
  z.object({ name: VariableNameSchema, secretRef: SecretRefSchema }).strict(),
]).openapi("EnvironmentVariable", {
  description: "A plain value, or a reference to a secret whose value is never returned: source environment is a Tenant secret stored encrypted on this Environment under key; source platform is a deployment secret, only obtained by copying a Built-in Environment.",
});
export const EnvironmentVariableInputSchema = z.union([
  PlainVariableSchema,
  z.object({
    name: VariableNameSchema,
    secretRef: SecretRefSchema,
    value: text("value", ENVIRONMENT_ENV_MAX_BYTES).optional().openapi({
      description: "Source environment only: the secret's new value, stored encrypted and never returned. Omit it to keep the value the Environment (or, when copying, the source) already stores under key.",
    }),
  }).strict(),
]).openapi("EnvironmentVariableInput");

const OwnerTypeSchema = z.enum(["platform", "tenant"]).openapi("EnvironmentOwnerType", {
  description: "platform: a Built-in Environment, visible to every Tenant and read-only; tenant: the Tenant's own.",
});
const StatusSchema = z.enum(["pending", "building", "failed", "ready"]).openapi("EnvironmentStatus", {
  description: "pending until the builder starts the latest build, building while it runs, then ready or failed. A failed rebuild keeps the previous image serving.",
});
export const EnvironmentBuildSummarySchema = z.object({
  id: z.string(),
  status: z.enum(["pending", "running", "succeeded", "failed", "superseded"]),
  createdAt: DateTimeSchema,
  startedAt: DateTimeSchema.nullable(),
  finishedAt: DateTimeSchema.nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
}).openapi("EnvironmentBuildSummary");

export const EnvironmentSchema = z.object({
  id: z.string().openapi({ example: "env_video_production" }),
  ownerType: OwnerTypeSchema,
  name: z.string(),
  description: z.string(),
  baseImage: BaseImageSchema,
  initScript: z.string().openapi({ description: "Bash, run once per build as root in /home/user." }),
  env: z.array(EnvironmentVariableSchema),
  status: StatusSchema,
  image: z.string().nullable().openapi({ description: "The image digest that serves Sandboxes; null until a build first succeeds." }),
  manifest: z.record(z.string(), z.unknown()).nullable().openapi({ description: "Package and binary versions of image." }),
  lastBuild: EnvironmentBuildSummarySchema.nullable(),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
}).openapi("Environment");

export const EnvironmentSummarySchema = EnvironmentSchema.omit({ initScript: true, env: true, manifest: true }).openapi("EnvironmentSummary");

const fields = {
  description: text("description", 1000),
  baseImage: BaseImageSchema,
  initScript: z.string().refine((value) => !value.includes("\0"), { error: "initScript must not contain NUL characters" })
    .openapi({ description: "Bash script, at most 256 KiB (environment_init_script_too_large)." }),
  env: z.array(EnvironmentVariableInputSchema).max(500).openapi({
    description: "The complete variable set; it replaces the previous one. All plain and secret values together are at most 32 KiB (environment_env_too_large).",
  }),
};

export const CreateEnvironmentInputSchema = z.object({
  from: z.string().min(1).optional().openapi({
    description: "Copy this visible Environment (a built-in or the Tenant's own): its Base Image, script and variables, including secret values and platform secret references. Other fields override the copy; name defaults to \"<name>-copy\".",
  }),
  name: NameSchema.optional().openapi({ description: "Required unless copying. Unique among the Tenant's Environments." }),
  description: fields.description.optional(),
  baseImage: fields.baseImage.optional().openapi({ description: "Required unless copying." }),
  initScript: fields.initScript.optional(),
  env: fields.env.optional(),
}).strict().openapi("CreateEnvironmentInput");

export const UpdateEnvironmentInputSchema = z.object({
  name: NameSchema.optional(),
  description: fields.description.optional(),
  baseImage: fields.baseImage.optional(),
  initScript: fields.initScript.optional(),
  env: fields.env.optional(),
}).strict().openapi("UpdateEnvironmentInput");

const json = (schema: z.ZodType, description: string) => ({ description, content: { "application/json": { schema } } });
const error = (description: string) => json(ErrorSchema, description);
const params = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });
const common = {
  401: error("Missing or invalid tenant credential"),
};
const INVALID = "Invalid Environment: validation_error, environment_env_invalid, environment_env_reserved, environment_env_empty_value, environment_env_too_large (all values over 32 KiB), environment_init_script_too_large (over 256 KiB), environment_secret_ref_forbidden (a platform secret not carried from the Environment or its copy source) or environment_secret_missing (a Tenant secret reference without a value to keep)";

export const environmentOpenApiRoutes = [
  createRoute({
    method: "get",
    path: "/v1/environments",
    operationId: "listEnvironments",
    summary: "List Environments",
    description: "Built-in Environments first, then the Tenant's own, each by name. Deleted Environments are omitted. Not paginated.",
    tags: ["Environments"],
    responses: { ...common, 200: json(z.object({ data: z.array(EnvironmentSummarySchema) }).openapi("EnvironmentList"), "Visible Environments"), 403: error("Share access denied") },
  }),
  createRoute({
    method: "get",
    path: "/v1/environments/{id}",
    operationId: "getEnvironment",
    summary: "Get an Environment",
    description: "Secret values are never returned; a secret variable shows only its name and reference.",
    tags: ["Environments"],
    request: { params },
    responses: { ...common, 200: json(EnvironmentSchema, "Environment found"), 403: error("Share access denied"), 404: error("Environment not found (environment_not_found)") },
  }),
  createRoute({
    method: "post",
    path: "/v1/environments",
    operationId: "createEnvironment",
    summary: "Create or copy an Environment",
    description: "Creates a Tenant Environment, or copies a visible one with from. It starts pending with a queued build; nothing runs in the API.",
    tags: ["Environments"],
    request: { body: { required: true, content: { "application/json": { schema: CreateEnvironmentInputSchema } } } },
    responses: {
      ...common,
      201: json(EnvironmentSchema, "Environment created, pending its first build"),
      400: error(INVALID),
      403: error("Share access denied"),
      404: error("Environment to copy not found (environment_not_found)"),
      409: error("Name already used by another of the Tenant's Environments (environment_name_conflict)"),
      503: error("Secret storage requires OMA_PROVIDER_ENCRYPTION_KEY (environment_secrets_unavailable)"),
    },
  }),
  createRoute({
    method: "post",
    path: "/v1/environments/{id}",
    operationId: "updateEnvironment",
    summary: "Update an Environment",
    description: "Changing baseImage or initScript queues a build and supersedes the unfinished one; Sandboxes keep the current image until it succeeds. Changing name, description or env takes effect at once and never builds. env replaces the whole set; a Tenant secret sent without value keeps its stored value.",
    tags: ["Environments"],
    request: { params, body: { required: true, content: { "application/json": { schema: UpdateEnvironmentInputSchema } } } },
    responses: {
      ...common,
      200: json(EnvironmentSchema, "Environment updated"),
      400: error(INVALID),
      403: error("A Built-in Environment is read-only (environment_read_only), or share access denied"),
      404: error("Environment not found (environment_not_found)"),
      409: error("Name already used by another of the Tenant's Environments (environment_name_conflict)"),
      503: error("Secret storage requires OMA_PROVIDER_ENCRYPTION_KEY (environment_secrets_unavailable)"),
    },
  }),
  createRoute({
    method: "delete",
    path: "/v1/environments/{id}",
    operationId: "deleteEnvironment",
    summary: "Delete an Environment",
    description: "Soft delete: the Environment disappears from lists and reads, and its unfinished build is superseded; its image is kept for Sandboxes already using it.",
    tags: ["Environments"],
    request: { params },
    responses: {
      ...common,
      200: json(DeletedSchema, "Environment deleted"),
      403: error("A Built-in Environment is read-only (environment_read_only), or share access denied"),
      404: error("Environment not found (environment_not_found)"),
      409: error("An Agent uses the Environment (environment_in_use)"),
    },
  }),
];
