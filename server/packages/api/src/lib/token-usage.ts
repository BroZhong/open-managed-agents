import type { TokenUsageSummary } from "@oma-server/store";

export const EMPTY_TOKEN_USAGE: TokenUsageSummary = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  cacheHitRate: null,
};

export function tokenUsageToWire(usage: TokenUsageSummary) {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_tokens: usage.cacheReadTokens,
    cache_write_tokens: usage.cacheWriteTokens,
    total_tokens: usage.totalTokens,
    cache_hit_rate: usage.cacheHitRate,
  };
}
