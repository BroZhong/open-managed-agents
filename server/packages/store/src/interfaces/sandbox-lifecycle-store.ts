import type { SandboxBindingRow } from './delegation-store.js';
import type { PendingEventFence } from './pending-event-store.js';

/** A Turn's business execution identity, not an independent resource lease. */
export interface SandboxActivity {
  bindingId: string;
  sessionId: string;
  fence: PendingEventFence;
}
/**
 * A committed explicit reclamation (ADR-0023, "Release and reclamation"): the
 * binding row as it was claimed, `now` read at the claim. Until it completes
 * the binding admits no Turn and no binding transaction, so its Sandbox
 * and creation intent stay as claimed. Every Sandbox the gateway lists for the
 * binding is the reclamation's, whatever the row records: a binding without a
 * Sandbox can still have one a lost create left.
 */
export interface SandboxReclamation extends Pick<SandboxBindingRow, "sandboxId" | "creatingSince" | "now"> { bindingId: string }
/** One binding row and its Sessions, as the sweeper (ADR-0023, "The sweeper") reads them. */
export interface SandboxBindingFacts {
  sandboxId: string | null;
  creatingSince: Date | null;
  /** Termination claimed the reclamation and has not completed it. */
  reclaiming: boolean;
  /** Pending input of a non-terminated Session of the binding, or a resource use whose input is still pending. A use left by an acknowledged input does not count. */
  inUse: boolean;
  /** No Session of the binding is alive (also true when none is left). */
  allSessionsTerminated: boolean;
}
export interface SandboxSweepFacts {
  /** The database clock at the read: creation intents' deadlines are judged against it. */
  now: Date;
  /** Only the bindings that have a row in this schema. */
  bindings: Map<string, SandboxBindingFacts>;
}
/**
 * A binding that stays as it is until a Runner acts on it, whether or not
 * the gateway lists a Sandbox for it (ADR-0023, "The sweeper").
 */
export interface UnsettledBinding {
  bindingId: string;
  /** Creating since then, by the database clock, when set. */
  creatingSince: Date | null;
  /** A committed reclamation not completed yet: its claimer failed or was lost before it confirmed the kills. */
  reclaiming: boolean;
}
/** The sweeper's reads: the bindings it found Sandboxes for, and the ones it settles without. */
export interface SandboxSweepStore {
  /**
   * One read of the rows and Session facts of `bindingIds`. It creates no
   * row and takes no lock: the sweeper decides each action again just before
   * it is taken.
   */
  sweepFacts(bindingIds: readonly string[]): Promise<SandboxSweepFacts>;
  /**
   * At most `limit` bindings of this schema that no Turn may ever settle:
   * those being reclaimed first, then those Creating for at least
   * `intentDeadlineSeconds` by the database clock, the oldest intent first.
   * One autocommitted statement; it creates no row and takes no lock.
   */
  unsettled(intentDeadlineSeconds: number, limit: number): Promise<UnsettledBinding[]>;
  /**
   * The Environment a binding's Sandboxes are created from (ADR-0024): the
   * one its root Session froze, else that Session's Agent's; null when
   * neither names one. Read for a Sandbox the sweeper adopts.
   */
  bindingEnvironment(bindingId: string): Promise<string | null>;
}
export interface SandboxLifecycleStore {
  /** false means committed explicit deletion must finish before admission. */
  begin(activity: SandboxActivity): Promise<boolean>;
  /** Only observed settlement can attempt idle; callback runs inside the binding lock. */
  finish(activity: SandboxActivity, idle?: (sandboxId: string) => Promise<void>): Promise<void>;
  /**
   * Explicit termination only, after rechecking shared business users and
   * inputs: null while a non-terminated Session uses the binding or has input
   * queued. A committed reclamation is claimed again with `now` read anew.
   */
  claimReclamation(bindingId: string): Promise<SandboxReclamation | null>;
  /**
   * Clear the binding to Cold once its Sandboxes are confirmed missing. Only
   * for the reclamation `ticket` claimed: an old callback cannot clear a
   * binding that moved on after it.
   */
  completeReclamation(ticket: SandboxReclamation): Promise<void>;
}
