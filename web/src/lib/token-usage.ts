import type { SessionEvent } from "@/lib/types";

export interface TokenUsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Input plus output. Cache reads/writes are subsets of input. */
  totalTokens: number;
  cacheHitRate: number | null;
}

export interface TokenUsageResponse {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cache_hit_rate: number | null;
}

export const EMPTY_TOKEN_USAGE: TokenUsageSummary = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  cacheHitRate: null,
};

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

export function summarizeTokenUsage(events: SessionEvent[]): TokenUsageSummary {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;

  for (const event of events) {
    if (event.type !== "span.model_request_end") continue;
    if (!event.data || typeof event.data !== "object") continue;
    const usage = (event.data as { usage?: unknown }).usage;
    if (!usage || typeof usage !== "object") continue;
    const record = usage as Record<string, unknown>;

    inputTokens += tokenCount(record.inputTokens);
    outputTokens += tokenCount(record.outputTokens);
    cacheReadTokens += tokenCount(record.cacheReadTokens);
    cacheWriteTokens += tokenCount(record.cacheWriteTokens);
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens,
    cacheHitRate: inputTokens === 0 ? null : cacheReadTokens / inputTokens,
  };
}

export function tokenUsageFromResponse(
  usage: TokenUsageResponse | undefined,
): TokenUsageSummary {
  if (!usage) return { ...EMPTY_TOKEN_USAGE };
  const inputTokens = tokenCount(usage.input_tokens);
  const outputTokens = tokenCount(usage.output_tokens);
  const cacheReadTokens = tokenCount(usage.cache_read_tokens);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens: tokenCount(usage.cache_write_tokens),
    totalTokens: inputTokens + outputTokens,
    cacheHitRate: inputTokens === 0 ? null : cacheReadTokens / inputTokens,
  };
}

export function formatTokenCount(value: number): string {
  return value.toLocaleString("en-US");
}

export function formatCacheHitRate(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}
