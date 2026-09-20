import { useMemo } from "react";
import type { SessionEvent } from "@/lib/types";
import { summarizeTokenUsage } from "@/lib/token-usage";
import { latestContextUsage } from "@/lib/context-usage";
import { TokenUsageMetrics } from "@/components/token-usage-metrics";

/** Each mounted Session supplies its own durable history, including resumed Turns. */
export function SessionUsageFooter({ events }: { events: SessionEvent[] }) {
  const usage = useMemo(() => summarizeTokenUsage(events), [events]);
  const context = useMemo(() => latestContextUsage(events), [events]);
  return (
    <footer className="session-usage-footer" aria-label="Session usage">
      <TokenUsageMetrics usage={usage} context={context} compact className="session-usage-metrics" />
    </footer>
  );
}
