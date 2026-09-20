import type { SessionEvent } from "@/lib/types";

export interface ContextUsage {
  tokens: number | null;
  contextWindow: number | null;
  source: "sdk" | "estimate" | "unknown";
  model?: string;
}

const UNKNOWN: ContextUsage = { tokens: null, contextWindow: null, source: "unknown" };

/** Durable snapshots work identically for initial history and live SSE updates. */
export function latestContextUsage(events: SessionEvent[]): ContextUsage {
  let latest = UNKNOWN;
  for (const event of events) {
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== "object") continue;
    if (event.type === "agent.context_usage") {
      const contextWindow = typeof data.contextWindow === "number" && Number.isFinite(data.contextWindow) && data.contextWindow > 0
        ? data.contextWindow : null;
      const source = data.source === "sdk" || data.source === "estimate" ? data.source : "unknown";
      const tokens = contextWindow !== null && source !== "unknown" && typeof data.tokens === "number" && Number.isFinite(data.tokens) && data.tokens >= 0
        ? data.tokens : null;
      latest = { tokens, contextWindow, source: tokens === null ? "unknown" : source,
        model: typeof data.model === "string" ? data.model : undefined };
    } else if (
      (event.type === "agent.context_entry" && (data.entry as { type?: string } | undefined)?.type === "compaction") ||
      (event.type === "agent.compaction" && data.status === "completed")
    ) {
      // A persisted boundary can arrive before its usage snapshot (or be the
      // last event before recovery). Never retain the pre-compaction count.
      latest = { ...latest, tokens: null, source: "unknown" };
    }
  }
  return latest;
}
