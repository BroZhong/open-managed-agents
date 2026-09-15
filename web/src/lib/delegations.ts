import type { SessionDelta, SessionEvent } from "@/lib/types";
import type { TokenUsageResponse } from "@/lib/token-usage";

export interface DelegationExecution {
  id: string;
  childId: string;
  callerSessionId: string;
  callerTurnId: string;
  callerToolUseId: string;
  prompt: string;
  mode: string;
  status: string;
  turnId?: string;
  model?: string;
  thinking?: string;
  maxSteps: number;
  effectiveConfig?: Record<string, unknown>;
  result?: { status: string; reason: string; output: string };
  notificationStatus?: string;
  commands?: Array<{ id: string; executionId: string; kind: string; message: string; status: string; createdAt: string; appliedEventSeq?: number; callerSessionId?: string; callerTurnId?: string; callerToolUseId?: string }>;
  createdAt: string;
  updatedAt: string;
}
export interface DelegationOrigin {
  parentSessionId: string;
  parentTurnId: string;
  parentToolUseId: string;
}
export interface DelegationList {
  data: DelegationExecution[];
  has_more: boolean;
  next_cursor?: string;
  origin?: DelegationOrigin;
}
export interface ExecutionTrace {
  execution: DelegationExecution;
  data: SessionEvent[];
  deltas: SessionDelta[];
  has_more: boolean;
  next_cursor?: number;
  usage: TokenUsageResponse;
  workspaceId: string;
}
export function executionActive(status: string): boolean {
  return !["completed", "failed", "interrupted", "budget_exhausted", "recovery_required"].includes(status);
}
export function executionPath(sessionId: string, executionId: string): string {
  return `/v1/sessions/${encodeURIComponent(sessionId)}/delegations/${encodeURIComponent(executionId)}/events`;
}
export function executionLink(execution: DelegationExecution): string {
  return `/sessions/${encodeURIComponent(execution.childId)}/executions/${encodeURIComponent(execution.id)}`;
}
