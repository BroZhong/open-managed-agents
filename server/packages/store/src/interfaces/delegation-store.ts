import type { PendingEventFence } from "./pending-event-store.js";
import type { EventLogStoreAppendInput } from "./event-log-store.js";
import type { Session, StoredEvent } from "../types.js";

export type DelegationMode = "sync" | "async";
export type DelegationStatus = "queued" | "running" | "completed" | "failed" | "interrupted" | "budget_exhausted" | "recovery_required";
export interface DelegationCaller {
  tenantId: string;
  callerSessionId: string;
  callerTurnId: string;
  callerToolUseId: string;
}
export interface DelegationOrigin {
  parentSessionId: string;
  parentTurnId: string;
  parentToolUseId: string;
  /** Immutable resource identity inherited by every resumed execution. */
  sandboxSessionId: string;
}
export interface DelegationExecution extends DelegationCaller {
  id: string;
  childId: string;
  pendingEventId: string;
  sequence: number;
  mode: DelegationMode;
  status: DelegationStatus;
  prompt: string;
  apiKeyId?: string;
  model?: string;
  /** Present on executions accepted under parent-model inheritance; absent on legacy records. */
  modelSource?: "parent";
  thinking?: string;
  maxSteps: number;
  turnId?: string;
  effectiveConfig?: Record<string, unknown>;
  ownerId?: string;
  generation?: number;
  result?: DelegationOutcome;
  notificationStatus?: "pending" | "processing" | "processed" | "consumed" | "suppressed";
  notificationEventSeq?: number;
  notificationPendingEventId?: string;
  parentTerminationRequested?: boolean;
  consumedAt?: string;
  createdAt: string;
  updatedAt: string;
}
export interface DelegationOutcome {
  status: Exclude<DelegationStatus, "queued" | "running">;
  reason: string;
  output: string;
  /** Complete Events are authoritative; this is a reference, not another log. */
  trace: { sessionId: string; turnId?: string; afterSeq?: number };
}
export interface DelegationAcceptInput extends DelegationCaller {
  prompt: string;
  mode: DelegationMode;
  resume?: string;
  apiKeyId?: string;
  /** Trusted Host snapshot of the calling parent Turn model, including its provider. */
  parentModel: string;
  /** Trusted Host snapshot of the calling parent Turn thinking level; a synchronous wait resumes with it. */
  parentThinking?: string;
  thinking?: string;
  maxSteps: number;
  sandboxSessionId: string;
}
/**
 * The model and thinking a Turn runs with on every attempt. A delegation wait
 * records its calling parent Turn's, so recovery resumes that Turn unchanged.
 * History is never stored here: each native message, including the requesting
 * tool call, reaches the event log before Pi runs its tools.
 */
export interface TurnConfig {
  model?: string;
  thinking?: string;
}
export interface DelegationWait extends DelegationCaller {
  executionId: string;
  parentPendingEventId: string;
  config: TurnConfig;
  status: "waiting" | "consumed" | "cancelled";
  toolResultSeq?: number;
}
export interface DelegationCommand extends DelegationCaller {
  id: string;
  executionId: string;
  childId: string;
  kind: "steer" | "interrupt";
  message: string;
  status: "accepted" | "applied" | "not_applied";
  targetTurnId?: string;
  targetGeneration?: number;
  createdAt: string;
  appliedEventSeq?: number;
}
export interface ResourceUseLease {
  /** Settlement is owned by the Sandbox Turn, not result publication. */
  managedTurn?: boolean;
  sessionId: string;
  sandboxSessionId: string;
  pendingEventId: string;
  ownerId: string;
  generation: number;
}
/**
 * What a Skill Install placed into a Sandbox Binding's Sandbox
 * (ADR-0022): the Sandbox it went into, the Skill Set hash it installed and
 * the switch generation the Sandbox gave its `/skills` switch. It describes
 * that Sandbox only; a binding that now holds another Sandbox has nothing
 * installed until an install into that one is recorded.
 */
export interface InstalledSkillSet {
  sandboxId: string;
  setHash: string;
  /**
   * Counts the `/skills` switches of one Sandbox, increasing under its
   * install lock with every switch. The highest one names what `/skills`
   * points at, whatever order installs record in.
   */
  generation: number;
}
/**
 * How recording an install went: it is now the record; a later switch into
 * the same Sandbox is recorded already, so `/skills` no longer holds it; or the
 * binding no longer holds the Sandbox it went into.
 */
export type SkillSetRecordOutcome = "recorded" | "superseded" | "detached";
/**
 * A Sandbox Binding's row as `withBindingLock` reads it (ADR-0023).
 * The row records intent; whether a Sandbox exists is the gateway's answer.
 * Its state is derived: Ready while `sandboxId` is set, Creating while
 * `creatingSince` is, Cold when neither is.
 */
export interface SandboxBindingRow {
  sandboxId: string | null;
  /** When the creation intent was committed, by the database clock. */
  creatingSince: Date | null;
  /**
   * The database clock at this read. Whether a creation intent is past its
   * deadline is decided against it, never against a Runner's clock.
   */
  now: Date;
}
/**
 * The state a binding moves to: Ready with a Sandbox, or Cold, either of
 * which ends a creation intent; or Creating, whose `creating_since` is the
 * database's `now()` when the move commits.
 */
export type BindingTransition = { ready: string } | "cold" | "creating";
/**
 * A Sandbox unavailability a preparation of the binding's Sandbox observed
 * (ADR-0023): `code` and `reason` as the tool results it failed carry them.
 */
export interface SandboxUnavailability {
  code: string;
  reason: string;
}
/**
 * What `work` found of the binding's Sandbox: ready (connected, its mount
 * verified), which ends a recorded failure; or a failure, recorded with the
 * database clock as the binding's last error.
 */
export type SandboxObservation = "ready" | { failure: SandboxUnavailability };
export interface BindingLockResult<T> {
  value: T;
  /**
   * Absent: the row stays as it was read. A move begins a new state: it
   * records when, and clears the last error, which was the old state's.
   */
  next?: BindingTransition;
  /** Recorded by the same compare-and-set, after `next`. */
  observed?: SandboxObservation;
}
/**
 * A binding's Sandbox as the Session API reports it (ADR-0023), derived
 * from its row: `unavailable` while it records an error, else `ready` while
 * it records a Sandbox, `creating` while it records a creation intent (past
 * its deadline too: the next use reconciles it), and `cold` otherwise.
 */
export type SandboxState = "cold" | "creating" | "ready" | "unavailable";
export interface SandboxStatus {
  state: SandboxState;
  /**
   * When the state began, by the database clock: the binding's last move,
   * its first failure since, or its recovery from one. Null when the binding
   * never moved since migration 0025 (an unused binding is Cold).
   */
  since: Date | null;
  /**
   * The last Sandbox unavailability observed in the current state, recorded at
   * `at`; null once a preparation ended ready or the binding moved.
   */
  lastError: (SandboxUnavailability & { at: Date }) | null;
}
/** Coordination shares the pending-input lease: no second execution scheduler. */
export interface DelegationStore {
  /** Reconcile durable Session termination even when its input/lease was already removed. */
  reconcileTerminatedExecutions(sessionId?: string, limit?: number): Promise<DelegationExecution[]>;
  accept(input: DelegationAcceptInput, fence: PendingEventFence): Promise<DelegationExecution>;
  getChild(tenantId: string, childId: string): Promise<Session | null>;
  getExecution(tenantId: string, executionId: string): Promise<DelegationExecution | null>;
  listExecutions(tenantId: string, opts: { callerSessionId?: string; callerTurnId?: string; callerToolUseId?: string; childId?: string; limit?: number; afterId?: string }): Promise<DelegationExecution[]>;
  /**
   * Read the binding (created Cold on first use), run `work` on it, then
   * move it to `next` and record what it `observed` by compare-and-set: they
   * apply only while the row is still as `work` read it, and otherwise
   * reject with `SandboxBindingChanged`. A `work` that throws
   * moves nothing. No database lock or pooled client is held while `work`
   * runs, which may call the gateway; callers of one store are serialized per
   * binding. Rejects while the binding's reclamation is in progress.
   */
  withBindingLock<T>(bindingId: string, work: (binding: SandboxBindingRow) => Promise<BindingLockResult<T>>): Promise<T>;
  /**
   * The binding's Sandbox for the Session API (ADR-0023). One plain
   * read: it takes no lock, creates no row and answers for a binding under
   * reclamation too.
   */
  sandbox(bindingId: string): Promise<SandboxStatus>;
  /** The binding's last recorded Skill Install; null when none was recorded. */
  installedSkillSet(bindingId: string): Promise<InstalledSkillSet | null>;
  /**
   * Record a complete Skill Install by compare-and-set: it applies only while
   * the binding still holds `installed.sandboxId`, so a rebuilt or reclaimed
   * binding never inherits it, and only over the record of an earlier switch
   * (another Sandbox's, or a lower generation), so the record follows the
   * last switch of `/skills`. No lock outlives it, and it never conflicts with
   * a binding operation, which compares only the Sandbox identity.
   */
  recordSkillSetInstall(bindingId: string, installed: InstalledSkillSet): Promise<SkillSetRecordOutcome>;
  get(tenantId: string, callerSessionId: string, childId: string, executionId?: string): Promise<DelegationExecution | null>;
  getByPendingEventId(pendingEventId: string): Promise<DelegationExecution | null>;
  list(tenantId: string, callerSessionId: string): Promise<DelegationExecution[]>;
  /** Fenced + parent quota serialized. false means a durable queued input must wait. */
  startExecution(executionId: string, fence: PendingEventFence, turnId: string, effectiveConfig: Record<string, unknown>, maxConcurrent: number): Promise<DelegationExecution | null>;
  /** Merge the runtime-resolved model configuration under the live execution fence. */
  updateEffectiveConfig(executionId: string, fence: PendingEventFence, config: Record<string, unknown>): Promise<void>;
  /** Child terminal + parent notification event + async pending input commit together. */
  finishExecution(executionId: string, fence: PendingEventFence, outcome: DelegationOutcome): Promise<DelegationExecution>;
  saveWait(wait: Omit<DelegationWait, "status">, fence: PendingEventFence): Promise<DelegationWait>;
  listWaits(parentSessionId: string, parentPendingEventId: string): Promise<DelegationWait[]>;
  /** Append final parent tool result and suppress unclaimed async delivery atomically. */
  consumeResult(executionId: string, caller: DelegationCaller, fence: PendingEventFence, event: EventLogStoreAppendInput): Promise<StoredEvent>;
  markNotificationProcessed(executionId: string, parentFence: PendingEventFence): Promise<void>;
  cancelWaits(parentSessionId: string, parentTurnId: string, fence?: PendingEventFence): Promise<void>;
  command(input: DelegationCaller & { childId: string; executionId?: string; kind: "steer" | "interrupt"; message: string }, callerFence?: PendingEventFence): Promise<DelegationCommand>;
  listCommands(executionId: string): Promise<DelegationCommand[]>;
  /** History injection + command acknowledgement share a transaction and lease fence. */
  applyCommand(commandId: string, fence: PendingEventFence, event: EventLogStoreAppendInput): Promise<DelegationCommand>;
  acquireResourceUse(sessionId: string, sandboxSessionId: string, fence: PendingEventFence): Promise<ResourceUseLease>;
  releaseResourceUse(sessionId: string, fence: PendingEventFence): Promise<void>;
  hasResourceUsers(sandboxSessionId: string): Promise<boolean>;
}
