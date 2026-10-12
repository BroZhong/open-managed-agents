import { z } from "@hono/zod-openapi";
import type { ThinkingOptions } from "@open-managed-agents/adapter-pi-agent";
export const ThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const CapabilityReferenceSchema = z.object({ provider: z.string(), modelId: z.string() });
export const ThinkingOptionsSchema = z.object({
  model: z.string(),
  choices: z.array(z.object({ value: ThinkingLevelSchema, label: ThinkingLevelSchema })).min(1).max(7),
  resolvedLevels: z.record(ThinkingLevelSchema, ThinkingLevelSchema),
  defaultLevel: ThinkingLevelSchema,
  control: z.enum(["app", "provider"]).optional(),
  source: z.enum(["manual", "upstream", "catalog", "default"]).optional(),
  reference: CapabilityReferenceSchema.optional(),
  profile: z.literal("anthropic-adaptive").optional(),
  recommendations: z.array(CapabilityReferenceSchema.extend({ name: z.string(), reason: z.string() })).optional(),
});
export type ThinkingOptionsReader = (tenantId: string, model: string) => Promise<ThinkingOptions>;

/** Configured internal service only; user input cannot select an endpoint. */
export function runnerThinkingOptions(baseUrl: string, request: typeof fetch = fetch) {
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new Error("Invalid Runner metadata URL");
  return async (model: string): Promise<ThinkingOptions> => {
    const url = new URL("/model-thinking-options", base);
    url.searchParams.set("model", model);
    const response = await request(url, { signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!response.ok) throw new Error("Model thinking options unavailable");
    return ThinkingOptionsSchema.parse(await response.json());
  };
}
