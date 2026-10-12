import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { Agent } from "./use-agents";
export type ThinkingLevel = NonNullable<Agent["thinking"]>;
export const thinkingLabels: Record<ThinkingLevel, string> = { off: "关闭", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最大" };
export interface ThinkingOptions {
  model: string;
  choices: { value: ThinkingLevel; label: ThinkingLevel }[];
  resolvedLevels: Record<ThinkingLevel, ThinkingLevel>;
  defaultLevel: ThinkingLevel;
  control?: "app" | "provider";
  source?: "manual" | "upstream" | "catalog" | "default";
  reference?: { provider: string; modelId: string };
  recommendations?: { provider: string; modelId: string; name: string; reason: string }[];
}

/** A reasoning boolean alone does not identify the model's supported levels. */
export function hasUnconfirmedThinkingLevels(options?: ThinkingOptions): boolean {
  return !!options && !options.reference &&
    (options.source === "default" || options.source === "upstream") &&
    options.choices.some(choice => choice.value !== "off");
}

export function thinkingChoiceLabel(options: ThinkingOptions | undefined, level: ThinkingLevel): string {
  return level === "off" && hasUnconfirmedThinkingLevels(options)
    ? "请求关闭（未确认）" : thinkingLabels[level];
}

export function validateThinkingOptions(options: ThinkingOptions): ThinkingOptions {
  const levels = Object.keys(thinkingLabels) as ThinkingLevel[];
  if (!options || !Array.isArray(options.choices) || !options.choices.length || !options.resolvedLevels ||
      options.choices.some(choice => !levels.includes(choice.value) || !levels.includes(choice.label)) ||
      !options.choices.some(choice => choice.value === options.defaultLevel) ||
      levels.some(level => !options.choices.some(choice => choice.value === options.resolvedLevels[level]))) {
    throw new Error("Invalid model thinking options");
  }
  return options;
}

export function useModelThinkingOptions(model?: string, enabled = true) {
  return useQuery({
    queryKey: ["model-thinking-options", model],
    enabled: enabled && !!model,
    staleTime: 60_000,
    retry: false,
    queryFn: async ({ signal }) => validateThinkingOptions(await apiFetch<ThinkingOptions>(
      `/v1/model-thinking-options?model=${encodeURIComponent(model!)}`, { signal },
    )),
  });
}
export function useThinkingOptions(sessionId: string, model?: string, runtime?: string) {
  return useQuery({
    queryKey: ["session-thinking-options", sessionId, model],
    enabled: !!sessionId && !!model && runtime === "pi-agent",
    staleTime: 60_000,
    retry: false,
    queryFn: async ({ signal }) => {
      const options = await apiFetch<ThinkingOptions>(`/v1/sessions/${sessionId}/thinking-options`, { signal });
      return validateThinkingOptions(options);
    },
  });
}
