import { createRoute, z } from "@hono/zod-openapi";
const text = z.string().trim().min(1).max(200);
export const ProviderModelSchema = z
  .object({
    id: text,
    name: text,
    contextWindow: z.number().int().min(1024).max(10_000_000),
    maxTokens: z.number().int().min(128).max(1_000_000),
    reasoning: z.boolean(),
    input: z
      .array(z.enum(["text", "image"]))
      .min(1)
      .max(2),
    catalogProvider: text.optional(),
  })
  .refine((model) => model.maxTokens <= model.contextWindow, {
    message: "Max output tokens must not exceed the context window",
  });
export const ProviderInputSchema = z.object({
  id: z
    .string()
    .regex(/^custom-[a-f\d-]{36}$/)
    .optional(),
  name: text,
  api: z.enum(["openai-completions", "openai-responses", "anthropic-messages"]),
  baseUrl: z.string().trim().url().max(2048),
  apiKey: z.string().max(8192).optional(),
  models: z
    .array(ProviderModelSchema)
    .min(1)
    .max(10)
    .refine(
      (models) =>
        new Set(models.map((model) => model.id)).size === models.length,
      { message: "Model IDs must be unique" },
    ),
});
export const ProviderDiscoverySchema = ProviderInputSchema.pick({
  id: true,
  api: true,
  baseUrl: true,
  apiKey: true,
});
const PublicProvider = ProviderInputSchema.omit({ apiKey: true }).extend({
  id: z.string(),
  hasApiKey: z.boolean(),
  testedAt: z.string(),
});
const response = (schema: z.ZodType, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const body = (schema: z.ZodType) => ({
  required: true,
  content: { "application/json": { schema } },
});
const errors = {
  400: response(
    z.object({ error: z.string() }),
    "Invalid configuration or expired test",
  ),
  401: response(z.object({ error: z.string() }), "Authentication required"),
  403: response(z.object({ error: z.string() }), "Share access denied"),
  404: response(z.object({ error: z.string() }), "Provider not found"),
  422: response(z.object({ error: z.string() }), "Model request failed"),
  503: response(
    z.object({ error: z.string() }),
    "Provider encryption is not configured",
  ),
};
export const modelProviderRoutes = [
  createRoute({
    method: "get",
    path: "/v1/model-providers",
    operationId: "listModelProviders",
    summary: "List this Tenant's providers without credentials",
    tags: ["Model Providers"],
    responses: {
      ...errors,
      200: response(
        z.object({ data: z.array(PublicProvider) }),
        "Tenant providers",
      ),
    },
  }),
  createRoute({
    method: "get",
    path: "/v1/model-providers/protocols",
    operationId: "getModelProviderProtocols",
    summary: "List supported Pi protocols",
    tags: ["Model Providers"],
    responses: {
      ...errors,
      200: response(
        z.object({
          protocols: z.array(z.object({ id: z.string(), name: z.string() })),
        }),
        "Supported protocols",
      ),
    },
  }),
  createRoute({
    method: "post",
    path: "/v1/model-providers/discover",
    operationId: "discoverModelProviderModels",
    summary:
      "Fetch models from the configured provider endpoint using its credentials",
    tags: ["Model Providers"],
    request: { body: body(ProviderDiscoverySchema) },
    responses: {
      ...errors,
      200: response(
        z.object({ data: z.array(ProviderModelSchema) }),
        "Endpoint model list; empty means no models returned, not an inference test",
      ),
    },
  }),
  createRoute({
    method: "post",
    path: "/v1/model-providers/test",
    operationId: "testModelProvider",
    summary: "Make a small Pi inference request for every selected model",
    tags: ["Model Providers"],
    request: { body: body(ProviderInputSchema) },
    responses: {
      ...errors,
      200: response(
        z.object({ testedAt: z.string(), verificationToken: z.string() }),
        "Test passed; proof valid for this exact configuration for 15 minutes",
      ),
    },
  }),
  createRoute({
    method: "post",
    path: "/v1/model-providers",
    operationId: "saveModelProvider",
    summary: "Save a tested provider; id updates an existing Tenant provider",
    tags: ["Model Providers"],
    request: {
      body: body(
        ProviderInputSchema.extend({
          verificationToken: z.string().min(1).max(4096),
        }),
      ),
    },
    responses: { ...errors, 200: response(PublicProvider, "Saved provider") },
  }),
  createRoute({
    method: "delete",
    path: "/v1/model-providers/{id}",
    operationId: "deleteModelProvider",
    summary: "Remove a provider; future Turns using it will fail explicitly",
    tags: ["Model Providers"],
    request: { params: z.object({ id: z.string() }) },
    responses: {
      ...errors,
      200: response(z.object({ deleted: z.boolean() }), "Provider removed"),
    },
  }),
];
