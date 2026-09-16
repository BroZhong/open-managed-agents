import { useMemo } from "react";
import type { SessionEvent } from "@/lib/types";
import { summarizeTokenUsage } from "@/lib/token-usage";
import { TokenUsageMetrics } from "@/components/token-usage-metrics";

/** Each mounted Session supplies its own durable history, including resumed Turns. */
export function SessionUsageFooter({ events }: { events: SessionEvent[] }) {
  const usage = useMemo(() => summarizeTokenUsage(events), [events]);
  return (
    <footer className="session-usage-footer" aria-label="Session usage">
      <TokenUsageMetrics usage={usage} className="session-usage-metrics" />
    </footer>
  );
}
