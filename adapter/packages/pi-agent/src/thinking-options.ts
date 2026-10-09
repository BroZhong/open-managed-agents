import { clampThinkingLevel, getSupportedThinkingLevels, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createCustomProvider, type CustomProviderDefinition } from "./custom-provider.js";
import { resolveModel } from "./model-resolver.js";

const levels: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export interface ThinkingOptions {
  model: string;
  choices: { value: ModelThinkingLevel; label: ModelThinkingLevel }[];
  resolvedLevels: Record<ModelThinkingLevel, ModelThinkingLevel>;
  defaultLevel: ModelThinkingLevel;
}

/** Pi owns support/clamping; the UI only collapses equivalent provider efforts. */
export function thinkingOptions(model: Model<Api>): ThinkingOptions {
  const supported = getSupportedThinkingLevels(model);
  const effort = (level: ModelThinkingLevel) => model.thinkingLevelMap?.[level] ?? level;
  const groups = new Map<string, ModelThinkingLevel[]>();
  for (const level of supported) groups.set(effort(level), [...(groups.get(effort(level)) ?? []), level]);
  const choices = [...groups].map(([mapped, aliases]) => ({
    value: aliases.includes(mapped as ModelThinkingLevel) ? mapped as ModelThinkingLevel : aliases.at(-1)!,
    label: levels.includes(mapped as ModelThinkingLevel) ? mapped as ModelThinkingLevel : aliases.at(-1)!,
  }));
  const canonical = (level: ModelThinkingLevel) => choices.find(choice => effort(choice.value) === effort(clampThinkingLevel(model, level)))!.value;
  return {
    model: `${model.provider}/${model.id}`, choices,
    resolvedLevels: Object.fromEntries(levels.map(level => [level, canonical(level)])) as ThinkingOptions["resolvedLevels"],
    defaultLevel: canonical(supported.at(-1) ?? "off"),
  };
}

/** Runner only: use the same deployed Pi catalog as actual Turns, without refresh. */
export async function managedThinkingOptions(raw: string): Promise<ThinkingOptions> {
  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  return thinkingOptions(resolveModel(raw, runtime));
}

/** API-safe: isolated tenant metadata, no Host catalog, credentials or inference. */
export async function customThinkingOptions(raw: string, definition: Omit<CustomProviderDefinition, "apiKey">): Promise<ThinkingOptions> {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false });
  runtime.registerNativeProvider(createCustomProvider({ ...definition, apiKey: "" }, async () => { throw new Error("Metadata lookup cannot perform inference"); }));
  return thinkingOptions(resolveModel(raw, runtime));
}
