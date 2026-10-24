import { EnvironmentBindingChanged, type DelegationStore, type SandboxSweepStore } from "@oma-server/store";
import { INTENT_DEADLINE_SECONDS, SANDBOX_IDLE_SECONDS, type ListedSandbox, type SandboxClient } from "./sandbox-client.js";
import { SANDBOX_BINDING_LABEL, SWEEP_MAX_KILLS, selectSweep, type SandboxEnvironment, type SweepDecision, type SweepOptions } from "./sandbox-sweep.js";
import { killSandboxes } from "./sandbox-kill.js";
import { reconcileBinding } from "./sandbox-manager.js";
import { signallingBinding, type EnvironmentSignals } from "./environment-signals.js";

/** How often each Runner sweeps (ADR-0023): every 10 minutes, give or take up to 2. */
export const SWEEP_INTERVAL_MS = 10 * 60_000;
export const SWEEP_JITTER_MS = 2 * 60_000;
/** A round's log line names at most this many failed actions. */
const MAX_LOGGED_FAILURES = 10;

export interface SandboxSweeperDeps {
  client: Pick<SandboxClient, "listSandboxes" | "destroy" | "setTimeout">;
  /** The listed bindings' rows and Session facts, in one read. */
  facts: SandboxSweepStore;
  /** The Runner's own store: its binding operations queue behind this Runner's Turns'. */
  bindings: Pick<DelegationStore, "withEnvironmentLock">;
  /** The Runner's `OMA_ENVIRONMENT`: only Sandboxes of this environment are acted on. */
  environment: SandboxEnvironment;
  /** Tells a binding's waiters on every Runner that an adoption moved it out of Creating. */
  environmentSignals?: EnvironmentSignals;
  logger?: Pick<Console, "info">;
  /** Uniform in [0, 1): spreads the rounds of Runners started together. */
  random?: () => number;
}

/** The one `sandbox_sweep` line a round writes. */
export interface SweepRound {
  msg: "sandbox_sweep";
  env: SandboxEnvironment;
  /** Every Sandbox the gateway listed for the API key, other environments' included. */
  listed: number;
  /** As selected (`SweepCounts`): orphans to kill, Unresolved bindings to adopt, unused running Sandboxes to shorten, Ready Sandboxes without a deadline. */
  orphans: number;
  unresolved: number;
  unusedRunning: number;
  noDeadline: number;
  /** As made: Sandboxes confirmed missing, bindings that recorded a Sandbox they adopted, deadlines shortened to 30 minutes. */
  killed: number;
  adopted: number;
  shortened: number;
  /** Kills over the round's cap, left to the next round. */
  deferred: number;
  /** Actions the binding, read again just before, no longer called for. */
  skipped: number;
  /** Actions that failed; the next round decides them again. */
  failed: number;
  /** The first failed actions, by error name only: SDK messages can repeat gateway bodies (#260). */
  failures?: Array<{ sandboxId: string; action: "kill" | "adopt" | "shorten"; error: string }>;
  /** The Runner's shutdown stopped the round before every action was taken. */
  aborted?: true;
  /** The round could not list or read the bindings and took no action. */
  error?: string;
  ms: number;
}

type Kill = Extract<SweepDecision, { action: "kill" }>;
type Shorten = Extract<SweepDecision, { action: "shorten" }>;
type Adopt = Extract<SweepDecision, { action: "adopt" }>;

/** One round's state: what it counted so far and the kills it may still make. */
interface Round {
  line: SweepRound;
  kills: number;
  signal?: AbortSignal;
}
/** Whether the Runner's shutdown stops the round before its next action. */
function stopped(round: Round): boolean {
  if (round.signal?.aborted) round.line.aborted = true;
  return round.line.aborted === true;
}

/**
 * The sweeper (ADR-0023, "The sweeper"), one per Runner. A round lists every
 * Sandbox of the API key, reads the listed bindings with one query and
 * selects the actions (`selectSweep`). There is no lock between Runners:
 * before each action the binding is read again and the action decided again,
 * and only then taken, under the binding's environment lock (whose snapshot
 * and compare-and-set hold no database client while the gateway is called).
 * Every action is safe to repeat: two Runners killing one Sandbox both find
 * it missing, and only one compare-and-set adopts. A round kills at most
 * {@link SWEEP_MAX_KILLS} Sandboxes.
 */
export class SandboxSweeper {
  private readonly stopping = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private round?: Promise<void>;
  private readonly logger: Pick<Console, "info">;
  private readonly random: () => number;

  constructor(private readonly deps: SandboxSweeperDeps) {
    this.logger = deps.logger ?? console;
    this.random = deps.random ?? Math.random;
  }

  /** Sweep every period until {@link stop}: first at a random point of the first period, so Runners started together do not align. */
  start(): void {
    if (this.timer || this.round || this.stopping.signal.aborted) return;
    this.schedule(this.random() * SWEEP_INTERVAL_MS);
  }

  /** Start no round; one in flight stops before its next action. Resolves once it has. */
  async stop(): Promise<void> {
    this.stopping.abort();
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.round;
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const next = () => {
        this.round = undefined;
        if (!this.stopping.signal.aborted) this.schedule(SWEEP_INTERVAL_MS + (2 * this.random() - 1) * SWEEP_JITTER_MS);
      };
      this.round = this.sweep(this.stopping.signal).then(next, next);
    }, ms);
    this.timer.unref?.();
  }

  /** One round; it never rejects, and writes its `sandbox_sweep` line however it ended. */
  async sweep(signal?: AbortSignal): Promise<SweepRound> {
    const started = performance.now();
    const round: Round = {
      line: { msg: "sandbox_sweep", env: this.deps.environment, listed: 0, orphans: 0, unresolved: 0, unusedRunning: 0, noDeadline: 0,
        killed: 0, adopted: 0, shortened: 0, deferred: 0, skipped: 0, failed: 0, ms: 0 },
      kills: SWEEP_MAX_KILLS, signal,
    };
    const { line } = round;
    try {
      // Unfiltered: selection keeps another environment's Sandboxes, and an
      // unlabelled one is this environment's only if its binding has a row here.
      const listed = await this.deps.client.listSandboxes({ metadata: {}, states: ["running", "paused"] });
      line.listed = listed.length;
      const facts = await this.deps.facts.sweepFacts([...new Set(listed.flatMap((s) => s.metadata[SANDBOX_BINDING_LABEL] ?? []))]);
      const { decisions, counts } = selectSweep(listed, facts.bindings, this.options(facts.now));
      Object.assign(line, { orphans: counts.orphans, unresolved: counts.unresolved, unusedRunning: counts.unusedRunning, noDeadline: counts.noDeadline });
      const bySandbox = new Map(listed.map((sandbox) => [sandbox.sandboxId, sandbox]));
      // Binding by binding, in listing order: an adoption settles the
      // binding's Sandboxes together, as reconciliation does in ensure.
      const byBinding = new Map<string, SweepDecision[]>();
      for (const decision of decisions) {
        if (decision.action !== "keep" && decision.bindingId !== null) byBinding.set(decision.bindingId, [...byBinding.get(decision.bindingId) ?? [], decision]);
      }
      for (const [bindingId, group] of byBinding) {
        if (stopped(round)) break;
        const adoption = group.find((d): d is Adopt => d.action === "adopt");
        if (adoption) await this.adopt(round, bindingId, adoption, facts.bindings.get(bindingId)!.creatingSince!);
        else for (const decision of group as Array<Kill | Shorten>) await this.act(round, decision, bySandbox.get(decision.sandboxId)!);
      }
    } catch (error) {
      line.error = error instanceof Error ? error.message : String(error);
    } finally {
      line.ms = Math.round(performance.now() - started);
      this.logger.info(JSON.stringify(line));
    }
    return line;
  }

  private options(now: Date): SweepOptions {
    return { environment: this.deps.environment, now, intentDeadlineSeconds: INTENT_DEADLINE_SECONDS,
      idleSeconds: SANDBOX_IDLE_SECONDS, maxKills: SWEEP_MAX_KILLS };
  }

  /** The decision for `sandbox` as its binding is now, and that binding row (undefined: none in this schema). */
  private async redecide(sandbox: ListedSandbox, bindingId: string) {
    const { now, bindings } = await this.deps.facts.sweepFacts([bindingId]);
    const [decision] = selectSweep([sandbox], bindings, this.options(now)).decisions;
    return { decision, row: bindings.get(bindingId) };
  }

  /**
   * Kill or shorten `sandbox` if, read again, its binding still calls for
   * it; then under the binding's lock, while the row is still as read. A
   * binding being reclaimed reads as such and is skipped; one claimed in the
   * moment between rejects the lock and counts as failed. A killed Sandbox the
   * row records leaves the binding Cold (ADR-0023: Ready → Cold once the
   * gateway confirms it missing).
   */
  private async act(round: Round, planned: Kill | Shorten, sandbox: ListedSandbox): Promise<void> {
    if (stopped(round)) return;
    const { line } = round;
    const bindingId = planned.bindingId!;
    if (planned.action === "kill" && (planned.deferred || round.kills <= 0)) { line.deferred++; return; }
    let acted = false;
    try {
      const { decision, row } = await this.redecide(sandbox, bindingId);
      if (decision.action !== planned.action) { line.skipped++; return; }
      // No row to lock (another schema's binding), and the lock would insert one.
      if (!row) { await this.kill(round, sandbox.sandboxId); return; }
      await this.deps.bindings.withEnvironmentLock<void>(bindingId, async (current) => {
        if (current.sandboxId !== row.sandboxId || current.creatingSince?.getTime() !== row.creatingSince?.getTime()) { line.skipped++; return { value: undefined }; }
        acted = true;
        if (planned.action === "shorten") {
          await this.deps.client.setTimeout(sandbox.sandboxId, SANDBOX_IDLE_SECONDS);
          line.shortened++;
          return { value: undefined };
        }
        const killed = await this.kill(round, sandbox.sandboxId);
        return { value: undefined, next: killed && current.sandboxId === sandbox.sandboxId ? "cold" : undefined };
      });
    } catch (error) {
      // The row moved on after the action was taken: nothing is left to do.
      if (error instanceof EnvironmentBindingChanged) { if (!acted) line.skipped++; return; }
      this.failed(line, sandbox.sandboxId, planned.action, error);
    }
  }

  /**
   * Reconcile a binding Creating past its deadline as ensure does, by the
   * same compare-and-set on its intent (`reconcileBinding`, which lists the
   * binding's Sandboxes again), then kill the Sandboxes it did not keep,
   * within the round's cap, and, if selection said so, shorten the one it
   * adopted if it is still unused. Skipped when another Runner, or a late
   * creator, moved the row first.
   */
  private async adopt(round: Round, bindingId: string, planned: Adopt, creatingSince: Date): Promise<void> {
    if (stopped(round)) return;
    const { line } = round;
    const { bindings, client, environmentSignals } = this.deps;
    let outcome: Awaited<ReturnType<typeof reconcileBinding>>;
    try {
      outcome = await reconcileBinding(client,
        signallingBinding({ id: bindingId, withLock: (work) => bindings.withEnvironmentLock(bindingId, work) }, environmentSignals), creatingSince);
    } catch (error) {
      if (error instanceof EnvironmentBindingChanged) line.skipped++;
      else this.failed(line, planned.sandboxId, "adopt", error);
      return;
    }
    // Moved on first, or nothing left to adopt (the binding went Cold).
    if (!outcome?.kept) { line.skipped++; return; }
    line.adopted++;
    for (const { sandboxId } of outcome.duplicates) {
      if (stopped(round)) return;
      if (round.kills <= 0) line.deferred++;
      else await this.kill(round, sandboxId);
    }
    if (planned.shorten) await this.act(round, { sandboxId: outcome.kept.sandboxId, bindingId, action: "shorten" }, outcome.kept);
  }

  /** Kill one Sandbox within the round's cap; true once it is confirmed missing. */
  private async kill(round: Round, sandboxId: string): Promise<boolean> {
    round.kills--;
    const { failed: [failure] } = await killSandboxes(this.deps.client, [sandboxId]);
    if (failure) { this.failed(round.line, sandboxId, "kill", failure.error); return false; }
    round.line.killed++;
    return true;
  }

  private failed(line: SweepRound, sandboxId: string, action: "kill" | "adopt" | "shorten", error: unknown): void {
    line.failed++;
    if ((line.failures ??= []).length < MAX_LOGGED_FAILURES) line.failures.push({ sandboxId, action, error: error instanceof Error ? error.name : typeof error });
  }
}
