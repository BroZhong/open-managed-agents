import { getModel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai/compat";

/** Matches the local Pi default; deployment provides its catalog in models.json. */
export const DEFAULT_MODEL = {
  provider: "openai-codex",
  id: "gpt-5.6-sol",
};

export interface ModelCatalog {
  getModel(provider: string, id: string): Model<Api> | undefined;
}

const builtinCatalog: ModelCatalog = {
  getModel: (provider, id) => getModel(provider as never, id as never),
};

function classify(raw: string): { provider: string; id: string } {
  const model = raw.trim();
  if (!model || model === "default") return DEFAULT_MODEL;

  // Explicit provider/id preserves custom providers from Pi's models.json.
  const slash = model.indexOf("/");
  if (slash > 0) {
    return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
  }

  const lower = model.toLowerCase();
  if (lower === "k3") return { provider: "kimi-coding-plan", id: "k3" };
  if (lower === "gpt-6-astra" || lower === "gpt-5.6-sol") {
    return { provider: "openai-codex", id: lower };
  }
  if (lower.startsWith("claude") || lower.startsWith("anthropic")) {
    return { provider: "anthropic", id: model };
  }
  if (lower === "codex" || lower.startsWith("openai-codex") || lower.includes("codex")) {
    return {
      provider: "openai-codex",
      id: lower === "codex" || lower === "openai-codex" ? DEFAULT_MODEL.id : model,
    };
  }
  if (/^(gpt|o1|o3|o4|openai)/.test(lower)) {
    return { provider: "openai", id: model };
  }
  if (lower.startsWith("gemini") || lower.startsWith("google")) {
    return { provider: "google", id: model };
  }
  return { provider: "anthropic", id: model };
}

/**
 * Managed Turns supply the same ModelRuntime that executes the request, so
 * custom model definitions, endpoint overrides, and auth stay consistent.
 * Unknown selections fail explicitly instead of executing a different model.
 */
export function resolveModel(
  raw: string | undefined,
  catalog: ModelCatalog = builtinCatalog,
): Model<Api> {
  const wanted = classify(raw ?? "");
  const model = catalog.getModel(wanted.provider, wanted.id);
  if (!model) {
    throw new Error(
      `Pi model ${wanted.provider}/${wanted.id} is not configured; add it to the Host Pi models.json`,
    );
  }
  return model;
}

/** Pi maps this level to the provider's effort (K3 xhigh maps to max). */
export function highestThinkingLevel(model: Model<Api>): ModelThinkingLevel {
  return getSupportedThinkingLevels(model).at(-1) ?? "off";
}
