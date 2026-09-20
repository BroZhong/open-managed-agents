import type { SessionEvent } from "./types";

export interface CompactionView {
  compactionId: string;
  status: string;
  reason?: string;
  summary?: string;
  tokensBefore?: number;
  tokensBeforeSource?: "usage" | "estimate";
  estimatedTokensAfter?: number;
  usage?: unknown;
  willRetry?: boolean;
  errorMessage?: string;
  retryErrors?: string[];
  attempt?: number;
  maxAttempts?: number;
  turnId?: string;
  seq: number;
}

/** A committed native entry is sufficient evidence even if its SDK end was lost. */
export function projectCompactions(events: SessionEvent[]): Map<number, CompactionView> {
  const records = new Map<string, CompactionView>();
  const seen = new Set<number>();
  for (const event of events) {
    if (seen.has(event.seq)) continue;
    seen.add(event.seq);
    const data = event.data as Partial<CompactionView> & { entry?: { type: string; id: string; summary?: string; tokensBefore?: number; usage?: unknown } };
    if (event.type === "agent.compaction" || event.type === "agent.context_entry" && data.entry?.type === "compaction") {
      const id = data.compactionId ?? data.entry?.id;
      if (!id) continue;
      const previous = records.get(id);
      const next = { ...previous, ...data, compactionId: id, seq: previous?.seq ?? event.seq, status: data.status ?? "completed" };
      if (data.status === "retrying" && data.errorMessage) next.retryErrors = [...(previous?.retryErrors ?? []), data.errorMessage];
      if (data.entry) Object.assign(next, { status: "completed", summary: data.entry.summary, tokensBefore: data.entry.tokensBefore, usage: data.entry.usage });
      // Retry diagnostics stay visible, but a completed result has no failure.
      if (next.status === "completed") delete next.errorMessage;
      records.set(id, next);
    }
    if (["session.turn_completed", "session.turn_aborted", "session.error", "session.status_idle"].includes(event.type)) {
      for (const record of records.values()) {
        if ((record.status === "started" || record.status === "retrying") && (!data.turnId || record.turnId === data.turnId)) record.status = "interrupted";
      }
    }
  }
  return new Map([...records.values()].map(record => [record.seq, record]));
}
