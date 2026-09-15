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
  model?: string;
  thinking?: string;
  maxSteps: number;
  sandboxSessionId: string;
  checkpoint?: Record<string, unknown>;
}
export interface DelegationWait extends DelegationCaller {
  executionId: string;
  parentPendingEventId: string;
  checkpoint: Record<string, unknown>;
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
  sessionId: string;
  sandboxSessionId: string;
  pendingEventId: string;
  ownerId: string;
  generation: number;
}
/** Coordination shares the pending-input lease: no second execution scheduler. */
export interface DelegationStore {
  accept(input: DelegationAcceptInput, fence: PendingEventFence): Promise<DelegationExecution>;
  getChild(tenantId: string, childId: string): Promise<Session | null>;
  getExecution(tenantId: string, executionId: string): Promise<DelegationExecution | null>;
  listExecutions(tenantId: string, opts: { callerSessionId?: string; callerTurnId?: string; callerToolUseId?: string; childId?: string; limit?: number; afterId?: string }): Promise<DelegationExecution[]>;
  withEnvironmentLock<T>(bindingId: string, work: (sandboxId: string | null) => Promise<{ sandboxId: string | null; value: T }>): Promise<T>;
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
