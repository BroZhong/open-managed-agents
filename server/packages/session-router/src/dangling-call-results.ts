import type { DanglingToolCall, RepairOutcome } from "./plan-resume.js";

/**
 * What the Agent is told about a call whose outcome no attempt committed when
 * its Turn moved to another Runner. Nothing is rerun: the Agent decides.
 */
export const OUTCOME_UNKNOWN =
  "The agent runtime restarted while this tool call was in progress, so its outcome is unknown. " +
  "It may not have run, may have partially completed, or may have finished, and a process it started may still be running. " +
  "Inspect the current state before deciding whether to retry. Do not assume it succeeded.";

/** What the Agent is told about a call an Interrupt stopped before its result was committed. */
export const INTERRUPTED =
  "The previous tool execution was interrupted before a result was committed. " +
  "Before retrying it, check whether it already took effect.";

/**
 * What a repair tells the Agent about a call without a result: a plan's
 * outcome, or the reason the call was not executed (a failed Skill Install).
 */
export type RepairCause = RepairOutcome | { notExecuted: string };

/** The result a repair writes for one dangling call. */
export interface RepairResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

/** The Turn a repair answers a call of. */
export interface RepairScope {
  sessionId: string;
  turnId: string;
  pendingEventId: string;
}

/**
 * Gives a call whose outcome is unknown the result durable state records for
 * it, such as a delegation tool's record (#251); undefined when it records
 * none. Registered by tool name, so the plan stays unaware of any tool.
 */
export type DanglingCallResolver = (call: DanglingToolCall, scope: RepairScope) => Promise<RepairResult | undefined>;

/**
 * The result for one dangling call: what its tool's resolver finds, else the
 * outcome-unknown result; a call an Interrupt stopped is always reported as
 * interrupted, and one that was not executed with the reason why.
 */
export async function repairResult(
  call: DanglingToolCall,
  outcome: RepairCause,
  resolvers: Readonly<Record<string, DanglingCallResolver>>,
  scope: RepairScope,
): Promise<RepairResult> {
  if (typeof outcome === "object") return { content: [{ type: "text", text: outcome.notExecuted }], isError: true };
  const resolve = outcome === "unknown" && call.name !== undefined && Object.hasOwn(resolvers, call.name) ? resolvers[call.name] : undefined;
  const resolved = await resolve?.(call, scope);
  if (resolved) return resolved;
  return { content: [{ type: "text", text: outcome === "unknown" ? OUTCOME_UNKNOWN : INTERRUPTED }], isError: true };
}
