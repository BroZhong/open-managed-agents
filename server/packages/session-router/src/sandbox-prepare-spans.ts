import type { SandboxPrepareObserver, SandboxPrepareOutcome } from "@oma-server/sandbox";
import type { StoredEvent } from "@oma-server/store";
import type { SpanSandboxPrepareEndEvent, SpanSandboxPrepareStartEvent } from "@open-managed-agents/adapter-core";
import type { JournalEvent } from "./turn-journal.js";

/** A span as the Host writes it: the event's own fields and its Turn. */
type SpanData<T> = Omit<T, "id" | "timestamp" | "type"> & { turnId: string };
export type SandboxPrepareStartData = SpanData<SpanSandboxPrepareStartEvent>;
export type SandboxPrepareEndData = SpanData<SpanSandboxPrepareEndEvent>;

/** The idempotency key segment of a preparation's span under its input. */
export const sandboxPrepareKey = (prepareId: string, edge: "start" | "end"): string => `sandbox_prepare:${prepareId}:${edge}`;

/** The reason a later attempt gives for the end of a preparation whose attempt stopped first. */
export const PREPARE_ATTEMPT_STOPPED = "the Turn attempt that ran the preparation stopped before it ended";
/** The reason the Turn's end gives for a preparation still running then: no tool waits for it any more. */
export const PREPARE_TURN_ENDED = "the Turn ended before the preparation did";

export interface SandboxPrepareSpansDeps {
  turnId: string;
  /** The attempt's claim generation: it names the attempt's preparations apart from every other attempt's. */
  generation: number;
  /** The events earlier attempts of the Turn wrote: whether they left its Sandbox unavailable. */
  events: readonly StoredEvent[];
  /** Record one of the attempt's own events under a key segment and write it now. */
  write(event: JournalEvent, keySegment: string): void;
}

/**
 * The Sandbox preparation spans of one Turn attempt (ADR-0023): a start when
 * a preparation of the Turn's Sandbox begins, an end when it ends,
 * written through the attempt's journal under keys of their own. An attempt
 * that stops writes nothing more; the attempt that takes its Turn over ends
 * what it started ({@link unendedSandboxPrepares}). The session runs one
 * preparation at a time.
 *
 * It also judges whether the Turn's Sandbox is unavailable
 * ({@link SandboxVerdict}), from what earlier attempts of the Turn
 * recorded and what this one sees. Only the Turn's end records that, as
 * `sandbox_unavailable`: planResume takes any session.error in a Turn as its
 * end, so mid-Turn a Sandbox unavailability is only a tool error.
 */
export class SandboxPrepareSpans implements SandboxPrepareObserver {
  private prepares = 0;
  private running?: { start: SandboxPrepareStartData; startedAt: number };
  private closed = false;
  private readonly verdict: SandboxVerdict;

  constructor(private readonly deps: SandboxPrepareSpansDeps) {
    this.verdict = SandboxVerdict.of(deps.events);
  }

  started(): void {
    if (this.closed) return;
    const start: SandboxPrepareStartData = { turnId: this.deps.turnId, prepareId: `${this.deps.generation}.${++this.prepares}` };
    this.running = { start, startedAt: performance.now() };
    this.deps.write({ type: "span.sandbox_prepare_start", data: start }, sandboxPrepareKey(start.prepareId, "start"));
  }

  ended(outcome: SandboxPrepareOutcome): void {
    this.verdict.prepareEnded(outcome.outcome);
    this.end(endOf(outcome));
  }

  /** A tool call of the attempt met a Sandbox unavailability: its executor operation did not run. */
  toolFailed(): void {
    this.verdict.toolFailed();
  }

  /** A tool call of the Turn met a Sandbox unavailability, and no preparation ended ready since. */
  unavailable(): boolean {
    return this.verdict.unavailable;
  }

  /**
   * The Turn ends: a preparation still running ends with it, aborted, since
   * no tool waits for it any more, and nothing more is recorded.
   */
  endTurn(): void {
    this.end({ outcome: "aborted", reason: PREPARE_TURN_ENDED });
    this.close();
  }

  /** The attempt stopped or ended: it records nothing more. */
  close(): void {
    this.closed = true;
    this.running = undefined;
  }

  private end(fields: Pick<SandboxPrepareEndData, "outcome" | "sandboxId" | "code" | "reason">): void {
    const running = this.running;
    if (!running || this.closed) return;
    this.running = undefined;
    const end: SandboxPrepareEndData = { ...running.start, ...fields, durationMs: Math.round(performance.now() - running.startedAt) };
    this.deps.write({ type: "span.sandbox_prepare_end", data: end }, sandboxPrepareKey(running.start.prepareId, "end"));
  }
}

function endOf(outcome: SandboxPrepareOutcome): Pick<SandboxPrepareEndData, "outcome" | "sandboxId" | "code" | "reason"> {
  switch (outcome.outcome) {
    case "ready": return { outcome: "ready", sandboxId: outcome.sandboxId };
    case "deferred": return { outcome: "deferred" };
    case "failed": return { outcome: "failed", code: outcome.error.code, reason: outcome.error.reason };
    case "aborted": return { outcome: "aborted", reason: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) };
  }
}

/** The Turn's preparation start spans without an end: their attempts stopped before the preparations ended. */
export function unendedSandboxPrepares(events: readonly StoredEvent[]): SandboxPrepareStartData[] {
  const ended = new Set(events.filter((event) => event.type === "span.sandbox_prepare_end")
    .map((event) => (event.data as { prepareId?: unknown } | null)?.prepareId));
  return events.filter((event) => event.type === "span.sandbox_prepare_start")
    .map((event) => event.data as SandboxPrepareStartData)
    .filter((start) => typeof start?.prepareId === "string" && !ended.has(start.prepareId));
}

/**
 * Whether a Turn's Sandbox is unavailable (ADR-0023, #287): a tool call of
 * the Turn, in any attempt, met a Sandbox unavailability, and no
 * preparation ended ready after it. A failed preparation no tool call waited
 * for leaves it available: a pure-chat Turn whose Turn-start connect failed
 * shows that in its span only. A deferred or aborted preparation changes
 * nothing.
 */
export class SandboxVerdict {
  /** A preparation failed and none ended ready since. */
  private failing = false;
  /** A tool call met that failure. */
  private met = false;

  /** The verdict `events`, a Turn's, leave: its preparations' end spans and its tool results. */
  static of(events: readonly StoredEvent[]): SandboxVerdict {
    const verdict = new SandboxVerdict();
    for (const event of events) {
      if (event.type === "span.sandbox_prepare_end") verdict.prepareEnded((event.data as { outcome?: unknown } | null)?.outcome);
      else if (sandboxUnavailableResult(event)) verdict.toolFailed();
    }
    return verdict;
  }

  get unavailable(): boolean {
    return this.met;
  }

  prepareEnded(outcome: unknown): void {
    if (outcome === "failed") this.failing = true;
    else if (outcome === "ready") this.failing = this.met = false;
  }

  /**
   * A tool call met a Sandbox unavailability. It counts only while a
   * failed preparation stands: Pi records a step's tool results after the
   * step, so the result of a call can follow the ready span of a preparation
   * a later call of the step ran after the failure.
   */
  toolFailed(): void {
    if (this.failing) this.met = true;
  }
}

/**
 * Whether `event` is the result of a tool call that met a Sandbox
 * unavailability: Pi's native toolResult entry carries the error's code
 * in its details.
 */
function sandboxUnavailableResult(event: StoredEvent): boolean {
  if (event.type !== "agent.context_entry") return false;
  const entry = (event.data as { entry?: { type?: string; message?: { role?: string; isError?: boolean; details?: { code?: unknown } } } } | null)?.entry;
  const message = entry?.type === "message" ? entry.message : undefined;
  return message?.role === "toolResult" && message.isError === true && message.details?.code === "sandbox_unavailable";
}
