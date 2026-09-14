import type { TokenUsageSummary } from "@/lib/token-usage";
import {
  formatCacheHitRate,
  formatTokenCount,
} from "@/lib/token-usage";
import { cn } from "@/lib/utils";

export function TokenUsageMetrics({
  usage,
  className,
}: {
  usage: TokenUsageSummary;
  className?: string;
}) {
  const metrics = [
    ["Total", formatTokenCount(usage.totalTokens)],
    ["Input", formatTokenCount(usage.inputTokens)],
    ["Output", formatTokenCount(usage.outputTokens)],
    ["Cache read", formatTokenCount(usage.cacheReadTokens)],
    ["Cache write", formatTokenCount(usage.cacheWriteTokens)],
    ["Cache hit", formatCacheHitRate(usage.cacheHitRate)],
  ] as const;

  return (
    <dl
      aria-label="Token usage"
      className={cn(
        "flex items-center divide-x divide-[var(--color-border)] rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]",
        className,
      )}
    >
      {metrics.map(([label, value]) => (
        <div key={label} className="px-2.5 py-1">
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
