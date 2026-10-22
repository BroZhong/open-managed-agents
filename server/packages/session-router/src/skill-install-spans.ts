import { SkillInstallError, type SkillInstallObserver, type SkillInstallReport, type SkillSet } from "@oma-server/sandbox";
import type { StoredEvent } from "@oma-server/store";
import type { SpanSkillsInstallEndEvent, SpanSkillsInstallStartEvent } from "@open-managed-agents/adapter-core";
import type { JournalEvent } from "./turn-journal.js";

/** A span as the Host writes it: the event's own fields and its Turn. */
type SpanData<T> = Omit<T, "id" | "timestamp" | "type"> & { turnId: string };
export type SkillInstallStartData = SpanData<SpanSkillsInstallStartEvent>;
export type SkillInstallEndData = SpanData<SpanSkillsInstallEndEvent>;

/** The idempotency key segment of an install's span under its input. */
export const skillInstallKey = (installId: string, edge: "start" | "end"): string => `skills_install:${installId}:${edge}`;

/** The reason a later attempt gives for the end of an install whose attempt stopped first. */
export const INSTALL_ATTEMPT_STOPPED = "the Turn attempt that ran the install stopped before it ended";

export interface SkillInstallSpansDeps {
  turnId: string;
  /** The attempt's claim generation: it names the attempt's installs apart from every other attempt's. */
  generation: number;
  /** Record one of the attempt's own events under a key segment and write it now. */
  write(event: JournalEvent, keySegment: string): void;
}

/**
 * The Skill Install spans of one Turn attempt (ADR-0022): a start when an
 * install the session runs for the Turn begins, an end when it ends, written
 * through the attempt's journal under keys of their own, so no attempt writes
 * another's. A skipped install writes neither. An attempt that stops writes
 * nothing more; the attempt that takes its Turn over ends what it started
 * ({@link unendedSkillInstalls}). The session runs one install at a time.
 */
export class SkillInstallSpans implements SkillInstallObserver {
  private installs = 0;
  private running?: { start: SkillInstallStartData; startedAt: number; ended(): void };
  private idle: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly deps: SkillInstallSpansDeps) {}

  started(skills: SkillSet): void {
    if (this.closed) return;
    const start: SkillInstallStartData = { turnId: this.deps.turnId, installId: `${this.deps.generation}.${++this.installs}`,
      setHash: skills.setHash, skills: skills.bundles.length };
    let ended!: () => void;
    this.idle = new Promise<void>((resolve) => { ended = resolve; });
    this.running = { start, startedAt: performance.now(), ended };
    this.deps.write({ type: "span.skills_install_start", data: start }, skillInstallKey(start.installId, "start"));
  }

  ended(outcome: { report: SkillInstallReport } | { error: unknown }): void {
    const running = this.running;
    if (!running) return;
    this.running = undefined;
    if (!this.closed) {
      const end: SkillInstallEndData = { ...running.start, ...endOf(outcome), durationMs: Math.round(performance.now() - running.startedAt) };
      this.deps.write({ type: "span.skills_install_end", data: end }, skillInstallKey(running.start.installId, "end"));
    }
    running.ended();
  }

  /** Resolves once no install of the attempt runs: each one's end span is recorded. */
  settled(): Promise<void> {
    return this.idle;
  }

  /** The attempt stopped or ended: it records nothing more. */
  close(): void {
    this.closed = true;
    this.running?.ended();
    this.running = undefined;
  }
}

function endOf(outcome: { report: SkillInstallReport } | { error: unknown }): Pick<SkillInstallEndData, "outcome" | "downloaded" | "bytes" | "stage" | "reason"> {
  if ("report" in outcome) return { outcome: "installed", downloaded: outcome.report.downloaded, bytes: outcome.report.bytes };
  const { error } = outcome;
  // A SkillInstallError's reason is redacted; anything else is the Turn signal's reason.
  if (error instanceof SkillInstallError) return { outcome: "failed", stage: error.stage, reason: error.reason };
  return { outcome: "aborted", reason: error instanceof Error ? error.message : String(error) };
}

/** The Turn's Skill Install start spans without an end: their attempts stopped before the installs ended. */
export function unendedSkillInstalls(events: readonly StoredEvent[]): SkillInstallStartData[] {
  const ended = new Set(events.filter((event) => event.type === "span.skills_install_end")
    .map((event) => (event.data as { installId?: unknown } | null)?.installId));
  return events.filter((event) => event.type === "span.skills_install_start")
    .map((event) => event.data as SkillInstallStartData)
    .filter((start) => typeof start?.installId === "string" && !ended.has(start.installId));
}
