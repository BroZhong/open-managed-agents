import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { Agent } from "./use-agents";
export type ThinkingLevel = NonNullable<Agent["thinking"]>;
export interface ThinkingOptions {
  model: string;
  choices: { value: ThinkingLevel; label: ThinkingLevel }[];
  resolvedLevels: Record<ThinkingLevel, ThinkingLevel>;
  defaultLevel: ThinkingLevel;
}
export function useThinkingOptions(sessionId: string, model?: string, runtime?: string) {
  return useQuery({
    queryKey: ["session-thinking-options", sessionId, model],
    enabled: !!sessionId && !!model && runtime === "pi-agent",
    staleTime: 60_000,
    retry: false,
    queryFn: async ({ signal }) => {
      const options = await apiFetch<ThinkingOptions>(`/v1/sessions/${sessionId}/thinking-options`, { signal });
      if (!Array.isArray(options?.choices) || !options.choices.length || !options.resolvedLevels || !options.choices.some(choice => choice.value === options.defaultLevel)) {
        throw new Error("Invalid model thinking options");
      }
      return options;
    },
  });
}
