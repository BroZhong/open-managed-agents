import { SandboxBindingChanged, type DelegationStore, type SandboxSweepStore } from "@oma-server/store";
import { INTENT_DEADLINE_SECONDS, SANDBOX_IDLE_SECONDS, SANDBOX_RUNNING_SECONDS, type ListedSandbox, type SandboxClient } from "./sandbox-client.js";
import { SANDBOX_BINDING_LABEL, SWEEP_MAX_KILLS, SWEEP_MAX_UNSETTLED, selectSweep, type SandboxEnvironment, type SweepDecision, type SweepOptions } from "./sandbox-sweep.js";
import { killSandboxes } from "./sandbox-kill.js";
import { reconcileBinding, type SandboxBinding, type SandboxManager } from "./sandbox-manager.js";
import { signallingBinding, type SandboxSignals } from "./sandbox-signals.js";

/** How often each Runner sweeps (ADR-0023): every 10 minutes, give or take up to 2. */
export const SWEEP_INTERVAL_MS = 10 * 60_000;
export const SWEEP_JITTER_MS = 2 * 60_000;
/** A round's log line names at most this many failed actions. */
const MAX_LOGGED_FAILURES = 10;

export interface SandboxSweeperDeps {
  client: Pick<SandboxClient, "listSandboxes" | "destroy" | "setTimeout">;
  /** The listed bindings' rows and Session facts, in one read, and the bindings no Turn settles. */
  facts: SandboxSweepStore;
  /** The Runner's own store: its binding operations queue behind this Runner's Turns'. */
  bindings: Pick<DelegationStore, "withBindingLock">;
  /**
   * Reclaims a binding as termination does (ADR-0023, "Release and
   * reclamation"): a round kills the Sandbox a binding records only so, and
   * completes the reclamations their claimer left.
   */
  manager: Pick<SandboxManager, "reclaim">;
  /** The Runner's `OMA_ENVIRONMENT`: only Sandboxes of this environment are acted on. */
  environment: SandboxEnvironment;
  /** Tells a binding's waiters on every Runner that a reconciliation moved it out of Creating (a reclamation tells them through the Manager). */
  sandboxSignals?: SandboxSignals;
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
  /** Bindings Creating past their deadline that the listing showed no Sandbox for, read from the schema (`SandboxSweepStore.unsettled`). */
  expired: number;
  /**
   * As made: Sandboxes confirmed missing, bindings that recorded a Sandbox
   * they adopted, Unresolved bindings moved to Cold because the gateway held
   * none, deadlines shortened to 30 minutes and set back to 24 hours because
   * a Turn began using the Sandbox meanwhile, reclamations left claimed that
   * the round completed.
   */
  killed: number;
  adopted: number;
  cleared: number;
  shortened: number;
  restored: number;
  reclaimed: number;
  /** Kills over the round's cap, left to the next round. */
  deferred: number;
  /** Actions the binding, read again just before, no longer called for. */
  skipped: number;
  /** Actions that failed; the next round decides them again. */
  failed: number;
  /** The first failed actions, by error name only: SDK messages can repeat gateway bodies (#260). */
  failures?: Array<FailedAction & { error: string }>;
  /** The Runner's shutdown stopped the round before every action was taken. */
  aborted?: true;
  /** The round could not list or read the bindings and took no action. */
  error?: string;
  ms: number;
}

/** A failed action, by the Sandbox it was taken on, or by binding when it was taken on the binding as a whole. */
type FailedAction =
  | { sandboxId: string; action: "kill" | "adopt" | "shorten" | "restore" }
  | { bindingId: string; action: "adopt" | "reclaim" };

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
 * selects the actions (`selectSweep`); it also reads the bindings no Turn
 * settles whatever the gateway lists (`SandboxSweepStore.unsettled`). There
 * is no lock between Runners: before each action the binding is read again
 * and the action decided again, and only then taken, under the binding's
 * lock (whose snapshot and compare-and-set hold no database
 * client while the gateway is called) or its reclamation, which a Turn's
 * admission also respects. Every action is safe to repeat: two Runners
 * killing one Sandbox both find it missing, only one compare-and-set adopts,
 * and a reclamation is completed once. A round kills at most
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
      line: { msg: "sandbox_sweep", env: this.deps.environment, listed: 0, orphans: 0, unresolved: 0, unusedRunning: 0, noDeadline: 0, expired: 0,
        killed: 0, adopted: 0, cleared: 0, shortened: 0, restored: 0, reclaimed: 0, deferred: 0, skipped: 0, failed: 0, ms: 0 },
      kills: SWEEP_MAX_KILLS, signal,
    };
    const { line } = round;
    try {
      // Unfiltered: selection keeps another environment's Sandboxes, and an
      // unlabelled one is this environment's only if its binding has a row here.
      const listed = await this.deps.client.listSandboxes({ metadata: {}, states: ["running", "paused"] });
      line.listed = listed.length;
      const facts = await this.deps.facts.sweepFacts([...new Set(listed.flatMap((s) => s.metadata[SANDBOX_BINDING_LABEL] ?? []))]);
      const unsettled = await this.deps.facts.unsettled(INTENT_DEADLINE_SECONDS, SWEEP_MAX_UNSETTLED);
      const { decisions, counts } = selectSweep(listed, facts.bindings, this.options(facts.now));
      Object.assign(line, { orphans: counts.orphans, unresolved: counts.unresolved, unusedRunning: counts.unusedRunning, noDeadline: counts.noDeadline });
      const bySandbox = new Map(listed.map((sandbox) => [sandbox.sandboxId, sandbox]));
      // Binding by binding, in listing order: an adoption settles the
      // binding's Sandboxes together, as reconciliation does in ensure.
      const byBinding = new Map<string, SweepDecision[]>();
      for (const decision of decisions) {
        if (decision.action !== "keep" && decision.bindingId !== null) byBinding.set(decision.bindingId, [...byBinding.get(decision.bindingId) ?? [], decision]);
      }
      // First the bindings the listing does not settle: a reclamation left
      // claimed keeps its Sessions' Turns waiting. An Unresolved binding with
      // a listed Sandbox is adopted below.
      for (const binding of unsettled) {
        if (stopped(round)) break;
        if (binding.reclaiming) await this.resume(round, binding.bindingId);
        else if (!byBinding.has(binding.bindingId)) {
          line.expired++;
          await this.reconcile(round, binding.bindingId, binding.creatingSince!);
        }
      }
      for (const [bindingId, group] of byBinding) {
        if (stopped(round)) break;
        const adoption = group.find((d): d is Adopt => d.action === "adopt");
        if (adoption) await this.reconcile(round, bindingId, facts.bindings.get(bindingId)!.creatingSince!, adoption);
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

  /** The binding as the Manager reclaims it, through this Runner's binding operations. */
  private binding(bindingId: string): SandboxBinding {
    return { id: bindingId, withLock: (work) => this.deps.bindings.withBindingLock(bindingId, work) };
  }

  /**
   * Kill or shorten `sandbox` if, read again, its binding still calls for
   * it. The Sandbox the row records is killed through the binding's
   * reclamation ({@link killRecorded}); any other Sandbox, and a deadline, under
   * the binding's lock while the row is still as read. A binding being
   * reclaimed reads as such and is skipped; one claimed in the moment between
   * rejects the lock and counts as failed. A shortened deadline is checked
   * once more against the binding's use ({@link restoreIfUsed}).
   */
  private async act(round: Round, planned: Kill | Shorten, sandbox: ListedSandbox): Promise<void> {
    if (stopped(round)) return;
    const { line } = round;
    const bindingId = planned.bindingId!;
    if (planned.action === "kill" && (planned.deferred || round.kills <= 0)) { line.deferred++; return; }
    let acted = false;
    let shortened = false;
    try {
      const { decision, row } = await this.redecide(sandbox, bindingId);
      if (decision.action !== planned.action) { line.skipped++; return; }
      // No row to lock (another schema's binding), and the lock would insert one.
      if (!row) { await this.kill(round, sandbox.sandboxId); return; }
      if (planned.action === "kill" && row.sandboxId === sandbox.sandboxId) { await this.killRecorded(round, bindingId, sandbox.sandboxId); return; }
      // A Sandbox the row does not record (superseded, of a Cold binding, of
      // one whose Sessions are all terminated) needs no fence against Turns:
      // no Turn uses it. A Turn uses only the Sandbox its binding records,
      // and a binding stops recording one only once it is confirmed missing
      // or reclaimed; a Turn adopts an unrecorded one only by reconciling an
      // intent written after this read, past its deadline, minutes after
      // this kill.
      await this.deps.bindings.withBindingLock<void>(bindingId, async (current) => {
        if (current.sandboxId !== row.sandboxId || current.creatingSince?.getTime() !== row.creatingSince?.getTime()) { line.skipped++; return { value: undefined }; }
        acted = true;
        if (planned.action === "kill") await this.kill(round, sandbox.sandboxId);
        else {
          await this.deps.client.setTimeout(sandbox.sandboxId, SANDBOX_IDLE_SECONDS);
          line.shortened++;
          shortened = true;
        }
        return { value: undefined };
      });
    } catch (error) {
      // The row moved on after the action was taken: nothing is left to do.
      if (!(error instanceof SandboxBindingChanged)) this.failed(line, { sandboxId: sandbox.sandboxId, action: planned.action }, error);
      else if (!acted) line.skipped++;
    }
    if (shortened) await this.restoreIfUsed(round, bindingId, sandbox.sandboxId);
  }

  /**
   * Kill the Sandbox the binding records, which a Turn may be about to use,
   * through the binding's reclamation, as termination does
   * (`SandboxManager.reclaim`): one claim under the row lock refuses it
   * while a live Session uses the binding or has input queued, and otherwise
   * makes Turn admission wait (`SandboxLifecycleStore.begin`); then the
   * Sandbox the row records and every one the gateway lists for the binding
   * are killed, the binding goes Cold and its waiting Turns are told. A Turn
   * admitted after the read that decided the kill therefore either keeps the
   * Sandbox or starts on a Cold binding; none loses its Sandbox in the
   * middle. Busy there also counts a use left by an acknowledged input, which
   * only keeps more. A claim the round leaves (a failed kill, a lost Runner)
   * is resumed by a later round ({@link resume}).
   */
  private async killRecorded(round: Round, bindingId: string, sandboxId: string): Promise<void> {
    round.kills--;
    const { line } = round;
    try {
      if (await this.deps.manager.reclaim(this.binding(bindingId))) line.killed++;
      else line.skipped++;
    } catch (error) {
      if (error instanceof SandboxBindingChanged) line.skipped++;
      else this.failed(line, { sandboxId, action: "kill" }, error);
    }
  }

  /**
   * Read the binding once more after shortening its Sandbox's deadline, and
   * set 24 hours back if it is in use: a Turn admitted since the decision may
   * have connected (24 hours) before the shorten, which would pause it 30
   * minutes into the Turn. The read closes that window without holding the
   * row lock across a gateway call: an admitted Turn's input stays pending
   * until the Turn acknowledges it at its end, so a Turn admitted before the
   * read is seen by it, and one whose input arrives after it connects after
   * the shorten completed, its connect setting 24 hours itself. Part of the
   * shorten: shutdown does not stop it.
   */
  private async restoreIfUsed(round: Round, bindingId: string, sandboxId: string): Promise<void> {
    try {
      const { bindings } = await this.deps.facts.sweepFacts([bindingId]);
      if (!bindings.get(bindingId)?.inUse) return;
      await this.deps.client.setTimeout(sandboxId, SANDBOX_RUNNING_SECONDS);
      round.line.restored++;
    } catch (error) {
      this.failed(round.line, { sandboxId, action: "restore" }, error);
    }
  }

  /**
   * Complete a reclamation its claimer left (termination's, or a round's
   * whose kill failed or whose Runner was lost): until it completes, its
   * Sessions' Turns are not admitted. Read again just before: a reclamation
   * completed meanwhile is not claimed anew, which would kill an idle
   * Sandbox for nothing. Retained (a create of its intent may still be in
   * flight) counts as skipped; the next round resumes it.
   */
  private async resume(round: Round, bindingId: string): Promise<void> {
    const { line } = round;
    if (round.kills <= 0) { line.deferred++; return; }
    try {
      const { bindings } = await this.deps.facts.sweepFacts([bindingId]);
      if (!bindings.get(bindingId)?.reclaiming) { line.skipped++; return; }
      round.kills--;
      if (await this.deps.manager.reclaim(this.binding(bindingId))) line.reclaimed++;
      else line.skipped++;
    } catch (error) {
      this.failed(line, { bindingId, action: "reclaim" }, error);
    }
  }

  /**
   * Reconcile a binding Creating past its deadline as ensure does, by the
   * same compare-and-set on its intent (`reconcileBinding`, which lists the
   * binding's Sandboxes again): adopt one, or move it to Cold when the
   * gateway holds none. Then kill the Sandboxes it did not keep, within the
   * round's cap, and, if selection said so, shorten the one it adopted if it
   * is still unused. Skipped when another Runner, or a late creator, moved
   * the row first. `planned`: the listed Sandbox selection chose to adopt;
   * none for a binding the listing showed no Sandbox for.
   */
  private async reconcile(round: Round, bindingId: string, creatingSince: Date, planned?: Adopt): Promise<void> {
    if (stopped(round)) return;
    const { line } = round;
    const { client, sandboxSignals } = this.deps;
    let outcome: Awaited<ReturnType<typeof reconcileBinding>>;
    try {
      outcome = await reconcileBinding(client, signallingBinding(this.binding(bindingId), sandboxSignals), creatingSince);
    } catch (error) {
      if (error instanceof SandboxBindingChanged) line.skipped++;
      else this.failed(line, planned ? { sandboxId: planned.sandboxId, action: "adopt" } : { bindingId, action: "adopt" }, error);
      return;
    }
    // Moved on first.
    if (!outcome) { line.skipped++; return; }
    if (!outcome.kept) { line.cleared++; return; }
    line.adopted++;
    for (const { sandboxId } of outcome.duplicates) {
      if (stopped(round)) return;
      if (round.kills <= 0) line.deferred++;
      else await this.kill(round, sandboxId);
    }
    if (planned?.shorten) await this.act(round, { sandboxId: outcome.kept.sandboxId, bindingId, action: "shorten" }, outcome.kept);
  }

  /** Kill one Sandbox within the round's cap; true once it is confirmed missing. */
  private async kill(round: Round, sandboxId: string): Promise<boolean> {
    round.kills--;
    const { failed: [failure] } = await killSandboxes(this.deps.client, [sandboxId]);
    if (failure) { this.failed(round.line, { sandboxId, action: "kill" }, failure.error); return false; }
    round.line.killed++;
    return true;
  }

  private failed(line: SweepRound, action: FailedAction, error: unknown): void {
    line.failed++;
    if ((line.failures ??= []).length < MAX_LOGGED_FAILURES) line.failures.push({ ...action, error: error instanceof Error ? error.name : typeof error });
  }
}
