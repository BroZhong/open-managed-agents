import type { DelegationExecution, DelegationWait, DelegationWaitConfig, StoredEvent } from "@oma-server/store";
import { presentEvent } from "@oma-server/store";
import type { AdapterResume } from "@open-managed-agents/adapter-core";
import { isTerminalExecution } from "./delegation-coordinator.js";

/**
 * What the Router knows durably about a claimed input once its promotion is
 * written: the input's Turn, as far as earlier attempts got, and the claim.
 */
export interface ResumeFacts {
  pendingEventId: string;
  /** The seq its promotion gave the input; a new Turn is named after it. */
  promotedSeq: number;
  /** The claim this attempt holds. */
  claim: { generation: number };
  /** Every event after the promoted input, in seq order. */
  events: readonly StoredEvent[];
  /** The delegation waits recorded for the input's Turn. */
  waits: readonly DelegationWait[];
  /**
   * The Child execution the input runs, as starting it under this claim left
   * it. The Router starts it only once the plan without it is not to
   * acknowledge, then plans again: an execution that has not ended changes
   * no plan, one that has ended ends the Turn.
   */
  execution?: Pick<DelegationExecution, "status" | "turnId" | "result">;
}

export type ResumePlan = AcknowledgePlan | CompletePlan | RunPlan;

/** The Turn completed; only the acknowledgement of its input is missing. */
export interface AcknowledgePlan {
  kind: "acknowledge";
  turnId: string;
}

/** End the Turn without running the Adapter: answer its dangling calls, record the error, complete it. */
export interface CompletePlan {
  kind: "complete";
  /** The Turn the repairs, the error and the completion name. */
  turnId: string;
  cause:
    /** The log already ends the Turn (idle, an error, turn_aborted) but has no completion marker. */
    | "turn_ended"
    /** An earlier attempt committed output and no wait resumes the Turn; it is not run again. */
    | "partial_output"
    /** The Child execution the input runs has ended, or its lost owner left its outcome uncertain. */
    | "execution_ended";
  /** Tool calls of the Turn without a result; each gets one before the Turn completes. */
  repairs: DanglingToolCall[];
  /** The session.error that ends the Turn, when its log does not end it yet. */
  error?: RecoveryError;
  /** Stop the synchronous children the Turn still waits on. */
  interruptChildren: boolean;
}

/** A tool call that has no result in the event log, as its call recorded it. */
export interface DanglingToolCall {
  type: "agent.tool_use" | "agent.mcp_tool_use";
  toolUseId: string;
  name?: string;
  /** The server of an MCP call, when the call names it. */
  serverName?: string;
}

/** A session.error that ends a Turn. */
export interface RecoveryError {
  /** Names the error's idempotency key under its input. */
  phase: string;
  code: string;
  message?: string;
  /** The Turn the error names, when it names one. */
  turnId?: string;
}

/** Run the Adapter for the Turn. */
export interface RunPlan {
  kind: "run";
  turnId: string;
  /** Continue the Turn an earlier attempt left waiting; absent for a new Turn, prompted with its input. */
  resume?: TurnResume;
}

/** How a run continues a Turn after what its earlier attempts committed. */
export interface TurnResume extends AdapterResume {
  /** The Turn's delegation waits; each still waiting is resumed for its result before the Turn goes on. */
  waits: DelegationWait[];
  /** The configuration the Turn started with. */
  config: DelegationWaitConfig;
  /**
   * Set when a call outside the waits has no result, so its outcome is
   * uncertain: once the waits have their results, the Turn ends with these
   * repairs and this error instead of continuing.
   */
  end?: { repairs: DanglingToolCall[]; error: RecoveryError };
}

/**
 * Decide, without I/O, how a claimed input proceeds from what is durable. The
 * first row that applies decides:
 *   1. its Turn completed: acknowledge the input;
 *   2. the Child execution it runs has ended: complete the Turn;
 *   3. the log ends the Turn: repair the dangling calls, complete it;
 *   4. the Turn waits on delegations: resume the waits;
 *   5. an earlier attempt committed output: repair, complete with an error;
 *   6. otherwise: run a new Turn.
 */
export function planResume(facts: ResumeFacts): ResumePlan {
  const waits = facts.waits.filter((wait) => wait.status !== "cancelled");
  // A wait belongs to the Turn that started it; any other attempt starts a Turn of its own.
  const turnId = waits[0]?.callerTurnId ?? `turn_${facts.promotedSeq}_a${facts.claim.generation}`;
  if (facts.events.some((event) => event.type === "session.turn_completed" &&
    (event.data as { pendingEventId?: unknown } | null)?.pendingEventId === facts.pendingEventId)) {
    return { kind: "acknowledge", turnId };
  }
  const execution = facts.execution;
  if (execution && isTerminalExecution(execution)) {
    const executionTurnId = execution.turnId ?? turnId;
    return execution.status === "recovery_required"
      ? { kind: "complete", cause: "execution_ended", turnId: executionTurnId, repairs: danglingToolCalls(facts.events), interruptChildren: false,
        error: { phase: "recovery_required", code: "recovery_required", message: execution.result?.reason, turnId: executionTurnId } }
      : { kind: "complete", cause: "execution_ended", turnId: executionTurnId, repairs: [], interruptChildren: false };
  }
  // A Delegation Result notification lands in the log by itself; it is not output of this Turn.
  const output = facts.events.filter((event) => event.type !== "subagent.result");
  if (output.some((event) => event.type === "session.status_idle" || event.type === "session.error" || event.type === "session.turn_aborted")) {
    return { kind: "complete", cause: "turn_ended", turnId, repairs: danglingToolCalls(output), interruptChildren: true };
  }
  if (waits.length) return { kind: "run", turnId, resume: resumeWaits(facts.events, turnId, waits) };
  if (output.some((event) => event.type !== "session.status_running")) {
    return { kind: "complete", cause: "partial_output", turnId, repairs: danglingToolCalls(output), interruptChildren: false,
      error: { phase: "recovery_partial_turn_aborted", code: "recovery_partial_turn_aborted",
        message: "A previous attempt stopped after committing partial output; it was not rerun to avoid mixing attempts." } };
  }
  return { kind: "run", turnId };
}

/**
 * Resuming the waits gives each waiting call its result, and nothing else:
 * whatever else dangles now still dangles after them.
 */
function resumeWaits(events: readonly StoredEvent[], turnId: string, waits: DelegationWait[]): TurnResume {
  const waitCalls = new Set(waits.map((wait) => wait.callerToolUseId));
  const uncertain = danglingToolCalls(events).filter((call) => !waitCalls.has(call.toolUseId));
  // The Turn continues after the model steps and output blocks it committed.
  const committed = events.filter((event) => (event.data as { turnId?: unknown } | null)?.turnId === turnId);
  return {
    // A wait saved before waits recorded configuration has none.
    waits, config: waits[0].config ?? {},
    completedModelSteps: committed.filter((event) => event.type === "span.model_request_start").length,
    blockBase: 1 + Math.max(-1, ...committed.flatMap((event) => presentEvent(event))
      .map((event) => (event.data as { blockIndex?: number } | null)?.blockIndex ?? -1)),
    ...(uncertain.length ? { end: { repairs: uncertain, error: { phase: "unsafe_continuation", code: "recovery_required", turnId,
      message: "A non-wait tool has an uncertain outcome. Inspect its external effects before continuing in a new Turn." } } } : {}),
  };
}

/**
 * The tool calls among `events` without a result, in call order: the one
 * judgement of which calls dangle. Native entries count through their display
 * blocks, so an assistant entry's tool calls, a toolResult entry and the
 * result an aborted assistant carries for a call whose arguments never
 * finished all count, alongside the display events of older histories.
 */
export function danglingToolCalls(events: readonly StoredEvent[]): DanglingToolCall[] {
  const displayed = events.flatMap((event) => presentEvent(event));
  const answered = new Set<string>();
  for (const event of displayed) {
    if (event.type !== "agent.tool_result" && event.type !== "agent.mcp_tool_result") continue;
    const data = event.data as { toolUseId?: unknown } | null;
    if (typeof data?.toolUseId === "string") answered.add(data.toolUseId);
  }
  const dangling: DanglingToolCall[] = [];
  for (const event of displayed) {
    if (event.type !== "agent.tool_use" && event.type !== "agent.mcp_tool_use") continue;
    const data = event.data as { toolUseId?: unknown; name?: unknown; serverName?: unknown } | null;
    if (typeof data?.toolUseId !== "string" || answered.has(data.toolUseId)) continue;
    dangling.push({ type: event.type, toolUseId: data.toolUseId,
      ...(typeof data.name === "string" ? { name: data.name } : {}),
      ...(typeof data.serverName === "string" ? { serverName: data.serverName } : {}) });
    // A call recorded twice is one call.
    answered.add(data.toolUseId);
  }
  return dangling;
}
