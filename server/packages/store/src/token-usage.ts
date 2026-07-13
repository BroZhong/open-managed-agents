import type { TokenUsageSummary } from "./types.js";

export interface TokenUsageCounts {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

function tokenCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/** Apply the shared accounting rules to provider-neutral token counts. */
export function summarizeTokenUsage(
  counts: TokenUsageCounts,
): TokenUsageSummary {
  const inputTokens = tokenCount(counts.inputTokens);
  const outputTokens = tokenCount(counts.outputTokens);
  const cacheReadTokens = tokenCount(counts.cacheReadTokens);
  const cacheWriteTokens = tokenCount(counts.cacheWriteTokens);

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens,
    cacheHitRate: inputTokens === 0 ? null : cacheReadTokens / inputTokens,
  };
}
