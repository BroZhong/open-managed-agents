import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { CustomModelDefinition, CustomProviderDefinition, CustomProviderProtocol } from "./custom-provider.js";

export interface CapabilityReference { provider: string; modelId: string }
export interface CapabilityRecommendation extends CapabilityReference { name: string; reason: string }
export interface CustomCapabilities {
  source: "manual" | "upstream" | "catalog" | "default";
  reference?: CapabilityReference;
  profile?: "anthropic-adaptive";
  recommendations: CapabilityRecommendation[];
}

// Only the bundled, credential-free catalog is read. Host models.json is never
// loaded by capability discovery, and catalog entries never become endpoint IDs.
function catalog(api: CustomProviderProtocol): Model<Api>[] {
  return getBuiltinProviders().flatMap(provider => getBuiltinModels(provider)).filter(model => model.api === api);
}

export function capabilityReferences(api: CustomProviderProtocol, modelId?: string) {
  const entries = catalog(api);
  const normalized = (id: string) => id.split("/").at(-1)!.toLowerCase().replace(/[._-]/g, "");
  const recommendations: CapabilityRecommendation[] = modelId ? entries
    .filter(model => model.id === modelId || normalized(model.id) === normalized(modelId))
    .map(model => ({ provider: model.provider, modelId: model.id, name: model.name,
      reason: model.id === modelId ? "Exact model ID; confirm the catalog provider when multiple entries match."
        : "Model ID matches after removing a route prefix or normalizing punctuation." })) : [];
  return {
    data: entries.map(model => ({ provider: model.provider, modelId: model.id, name: model.name, reasoning: model.reasoning })),
    recommendations,
  };
}

export function resolveCustomModel(
  definition: Pick<CustomProviderDefinition, "id" | "api" | "baseUrl">,
  model: CustomModelDefinition,
): { model: Model<Api>; capabilities: CustomCapabilities } {
  if (model.thinkingMode === "provider") {
    throw new Error("Provider-controlled thinking is unavailable: Pi cannot preserve Responses reasoning history while omitting all thinking controls.");
  }
  const adaptive = model.thinkingProfile === "anthropic-adaptive";
  if (model.thinkingProfile !== undefined && (!adaptive || definition.api !== "anthropic-messages")) {
    throw new Error("The Anthropic Adaptive thinking profile requires the Anthropic Messages protocol.");
  }
  const manualReference = model.capabilityReference ?? (model.catalogProvider ? { provider: model.catalogProvider, modelId: model.id } : undefined);
  let matched: Model<Api> | undefined;
  const entries = catalog(definition.api);
  if (manualReference) {
    matched = entries.find(item => item.provider === manualReference.provider && item.id === manualReference.modelId);
    if (!matched) throw new Error(`Capability reference ${manualReference.provider}/${manualReference.modelId} is unavailable for ${definition.api}. Clear or replace the reference.`);
  } else {
    const exact = entries.filter(item => item.id === model.id);
    if (exact.length === 1) matched = exact[0];
  }
  const explicitlyUnsupported = !manualReference && !adaptive && model.reasoningSource === "upstream" && model.reasoning === false;
  const reasoning = adaptive ? true : explicitlyUnsupported ? false : matched?.reasoning ?? true;
  const reference = matched ? { provider: matched.provider, modelId: matched.id } : undefined;
  const source = manualReference || adaptive ? "manual" : explicitlyUnsupported ? "upstream" : matched ? "catalog" : model.reasoningSource === "upstream" ? "upstream" : "default";
  return {
    model: {
      id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
      input: model.input, reasoning, api: definition.api, provider: definition.id, baseUrl: definition.baseUrl,
      // New references describe capabilities only. Preserve pricing solely for
      // the older explicit catalogProvider contract, which already imported it.
      cost: model.catalogProvider && !model.capabilityReference && matched
        ? matched.cost : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...(matched?.compat ? { compat: matched.compat } : {}),
      ...(matched?.thinkingLevelMap ? { thinkingLevelMap: matched.thinkingLevelMap } : {}),
      // Public Pi model metadata owns support/clamping and native serialization.
      // This user-selected profile does not infer capabilities from a model name.
      ...(adaptive ? {
        compat: { ...matched?.compat, forceAdaptiveThinking: true, supportsTemperature: false },
        thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
      } : {}),
    },
    capabilities: { source, ...(reference ? { reference } : {}), ...(adaptive ? { profile: "anthropic-adaptive" } : {}), recommendations: matched || adaptive ? [] : capabilityReferences(definition.api, model.id).recommendations },
  };
}
