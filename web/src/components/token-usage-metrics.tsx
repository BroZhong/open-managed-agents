import type { TokenUsageSummary } from "@/lib/token-usage";
import type { ContextUsage } from "@/lib/context-usage";
import {
  formatCacheHitRate,
  formatTokenCount,
} from "@/lib/token-usage";
import { cn } from "@/lib/utils";

export function TokenUsageMetrics({
  usage,
  className,
  compact = false,
  context,
}: {
  usage: TokenUsageSummary;
  className?: string;
  compact?: boolean;
  context?: ContextUsage;
}) {
  const contextValue = !context || context.contextWindow === null ? "—"
    : context.tokens === null ? `— / ${formatTokenCount(context.contextWindow)}`
    : `≈${formatTokenCount(context.tokens)} / ${formatTokenCount(context.contextWindow)} · ${(context.tokens / context.contextWindow * 100).toFixed(1)}%`;
  const contextTitle = context?.source === "estimate"
    ? "Estimated from the current messages after compaction; excludes system prompt and tool definitions. Updated after the next model response."
    : context?.source === "sdk"
      ? "Runtime context estimate: latest available model usage plus estimated newer messages, or a text estimate when usage is absent. This is not cumulative Total tokens."
      : "Current context usage is unavailable. The runtime reports it when the session runs; older history may not include it.";
  const metrics = [
    ["Total tokens", formatTokenCount(usage.totalTokens)],
    ...(context ? [["Context", contextValue]] : []),
    ["Input", formatTokenCount(usage.inputTokens)],
    ["Output", formatTokenCount(usage.outputTokens)],
    ["Cache read", formatTokenCount(usage.cacheReadTokens)],
    ["Cache write", formatTokenCount(usage.cacheWriteTokens)],
    ["KV cache hit", formatCacheHitRate(usage.cacheHitRate)],
  ] as const;

  return (
    <dl
      aria-label="Token usage"
      className={cn(
        "flex items-center divide-x divide-[var(--color-border)] rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]",
        className,
      )}
    >
      {metrics.filter(([label]) => !compact || label === "Total tokens" || label === "Context" || label === "KV cache hit").map(([label, value]) => (
        <div key={label} className="px-2.5 py-1" title={label === "Context" ? contextTitle : label === "KV cache hit" ? "Cache read tokens / input tokens" : `${label}: ${value}`}>
          <dt className="text-[10px] leading-3 text-[var(--color-fg-subtle)]">
            {label}
          </dt>
          <dd className="font-mono text-xs font-medium leading-4 text-[var(--color-fg)]">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
