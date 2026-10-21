import type { DelegationExecution, DelegationWait, DelegationWaitConfig, PendingEventClaimEnd, StoredEvent } from "@oma-server/store";
import { presentEvent } from "@oma-server/store";
import type { AdapterResume } from "@open-managed-agents/adapter-core";
import { isTerminalExecution } from "./delegation-coordinator.js";

/**
 * What the Router knows durably about a claimed input once its promotion is
 * written: the input's Turn, as far as earlier attempts got, and the claim.
 */
export interface ResumeFacts {
  pendingEventId: string;
  /** The seq its promotion gave the input; a Turn no earlier attempt named is named after it. */
  promotedSeq: number;
  /** The claim this attempt holds; its generation names a Turn no earlier attempt named. */
  claim: {
    generation: number;
    /** An earlier generation accepted an Interrupt for the input, and the Runner holding it stopped first. */
    priorInterrupt: boolean;
    /** How the claim before this one ended; null for the input's first claim. */
    previous: PendingEventClaimEnd | null;
  };
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

/**
 * This claim continues a Turn another claim held: the Runner holding it was
 * lost (its lease expired) or handed it over (it released the claim). The
 * Router records it as `session.turn_resumed`.
 */
export interface Takeover {
  reason: PendingEventClaimEnd;
  /** The Turn's tool calls that had no result when it moved, in call order. */
  danglingToolUseIds: string[];
}

/** What a repair tells the Agent about a call that has no result. */
export type RepairOutcome =
  /** The Turn ends as an Interrupted Turn: the Interrupt stopped the call. */
  | "interrupted"
  /** The Runner executing the call stopped first: it may not have run, or have run partly or fully. */
  | "unknown";

/** End the Turn without running the Adapter: answer its dangling calls, record the error, complete it. */
export interface CompletePlan {
  kind: "complete";
  /** The Turn the repairs, the error and the completion name. */
  turnId: string;
  cause:
    /** The log already ends the Turn (idle, an error, turn_aborted) but has no completion marker. */
    | "turn_ended"
    /** The Agent's final answer is committed: the Turn is done, no model request is made. */
    | "answered"
    /** The Child execution the input runs has ended, or its lost owner left its outcome uncertain. */
    | "execution_ended"
    /** An earlier attempt accepted an Interrupt it did not live to apply: the Turn ends as an Interrupted Turn. */
    | "interrupted";
  /** Tool calls of the Turn without a result; each gets one before the Turn completes. */
  repairs: DanglingToolCall[];
  repairOutcome: RepairOutcome;
  /** The session.error that ends the Turn, when its log does not end it yet. */
  error?: RecoveryError;
  /** Stop the synchronous children the Turn still waits on. */
  interruptChildren: boolean;
  takeover?: Takeover;
}

/** A tool call that has no result in the event log, as its call recorded it. */
export interface DanglingToolCall {
  type: "agent.tool_use" | "agent.mcp_tool_use";
  toolUseId: string;
  name?: string;
  /** The server of an MCP call, when the call names it. */
  serverName?: string;
}

/** A session.error that ends a Turn; it names the Turn it ends. */
export interface RecoveryError {
  /** Names the error's idempotency key under its input. */
  phase: string;
  code: string;
  message?: string;
}

/** Run the Adapter for the Turn. */
export interface RunPlan {
  kind: "run";
  turnId: string;
  /**
   * `prompt` hands the runtime the input: no attempt committed it into the
   * Turn's native history yet. `continue` resumes that history, which then
   * holds a result for every tool call, from the step it reached.
   */
  start: "prompt" | "continue";
  /** Where this attempt starts in the Turn, counted from what earlier attempts committed. */
  progress: AdapterResume;
  /** Calls without a result outside the waits; each gets an outcome-unknown result before the run. */
  repairs: DanglingToolCall[];
  /** The Turn's delegation waits; each still waiting is resumed for its result before the Turn goes on. */
  waits: DelegationWait[];
  /**
   * The model and thinking the Turn runs with on every attempt: those its
   * first attempt resolved, as it recorded them when it claimed the input, or
   * as a delegation wait recorded them. Absent while no attempt claimed the
   * input: the Turn then starts with the configuration current at this claim.
   */
  config?: DelegationWaitConfig;
  takeover?: Takeover;
}

/**
 * Decide, without I/O, how a claimed input proceeds from what is durable. The
 * first row that applies decides:
 *   1. its Turn completed: acknowledge the input;
 *   2. the Child execution it runs has ended: complete the Turn;
 *   3. the log ends the Turn: repair the dangling calls, complete it;
 *   4. an earlier generation accepted an Interrupt: repair, end as an Interrupted Turn;
 *   5. the Turn waits on delegations: resume the waits, give every other
 *      dangling call an outcome-unknown result, continue;
 *   6. the input is not in the Turn's native history yet: prompt it;
 *   7. the last message is the Agent's final answer: complete the Turn without a model request;
 *   8. otherwise (a tool call, a tool result, steering, the input itself, a
 *      failed or aborted request): give each dangling call an outcome-unknown
 *      result, continue.
 * No row reruns a tool or ends a Turn because it was taken over.
 *
 * Every attempt of the input executes one Turn, the one its first attempt
 * started: the plan names it after the first event of the input that names a
 * Turn (Pi's agent.context_start, recorded when Pi is prompted, or an earlier
 * takeover's marker). An input no attempt named yet is this attempt's Turn.
 * The Turn keeps the model and thinking that first claim recorded, so a
 * configuration edited mid-Turn applies from the next Turn.
 */
export function planResume(facts: ResumeFacts): ResumePlan {
  const waits = facts.waits.filter((wait) => wait.status !== "cancelled");
  // A Delegation Result notification lands in the log by itself; it is not output of this Turn.
  const output = facts.events.filter((event) => event.type !== "subagent.result");
  const turnId = output.map((event) => (event.data as { turnId?: unknown } | null)?.turnId)
    .find((named): named is string => typeof named === "string") ?? `turn_${facts.promotedSeq}_a${facts.claim.generation}`;
  if (facts.events.some((event) => event.type === "session.turn_completed" &&
    (event.data as { pendingEventId?: unknown } | null)?.pendingEventId === facts.pendingEventId)) {
    return { kind: "acknowledge", turnId };
  }
  const dangling = danglingToolCalls(output);
  const takeover: { takeover?: Takeover } = facts.claim.previous === null ? {}
    : { takeover: { reason: facts.claim.previous, danglingToolUseIds: dangling.map((call) => call.toolUseId) } };
  const complete = (cause: CompletePlan["cause"], plan: Partial<CompletePlan> = {}): CompletePlan => ({
    kind: "complete", cause, turnId, repairs: dangling, repairOutcome: "unknown", interruptChildren: false, ...plan, ...takeover,
  });
  const execution = facts.execution;
  if (execution && isTerminalExecution(execution)) {
    const executionTurnId = execution.turnId ?? turnId;
    return execution.status === "recovery_required"
      ? complete("execution_ended", { turnId: executionTurnId,
        error: { phase: "recovery_required", code: "recovery_required", message: execution.result?.reason } })
      : complete("execution_ended", { turnId: executionTurnId, repairs: [] });
  }
  if (output.some((event) => event.type === "session.status_idle" || event.type === "session.error" || event.type === "session.turn_aborted")) {
    return complete("turn_ended", { interruptChildren: true,
      repairOutcome: output.some((event) => event.type === "session.turn_aborted") ? "interrupted" : "unknown" });
  }
  // The user stopped this Turn and the log shows the stop never took effect.
  // Continuing it would ignore the stop, so it ends as the Interrupt would have ended it.
  if (facts.claim.priorInterrupt) return complete("interrupted", { repairOutcome: "interrupted", interruptChildren: true });
  const config = turnConfig(output, turnId);
  const run = (start: RunPlan["start"], plan: Partial<RunPlan> = {}): RunPlan => ({
    kind: "run", start, turnId, progress: turnProgress(output, turnId), repairs: dangling, waits: [],
    ...(config ? { config } : {}), ...plan, ...takeover,
  });
  if (waits.length) {
    const waitCalls = new Set(waits.map((wait) => wait.callerToolUseId));
    return run("continue", { repairs: dangling.filter((call) => !waitCalls.has(call.toolUseId)), waits,
      config: { ...config, ...waits[0].config } });
  }
  const last = lastMessage(output);
  if (!inputCommitted(output, last)) return run("prompt");
  if (last && isFinalAnswer(last)) return complete("answered");
  return run("continue");
}

/**
 * The model and thinking the Turn's first attempt ran with: the runtime
 * records what it resolved when it claims the input (agent.context_start),
 * before its first model request.
 */
function turnConfig(output: readonly StoredEvent[], turnId: string): DelegationWaitConfig | undefined {
  for (const event of output) {
    if (event.type !== "agent.context_start") continue;
    const data = event.data as { turnId?: unknown; model?: unknown; thinking?: unknown } | null;
    if (data?.turnId === turnId && typeof data.model === "string" && typeof data.thinking === "string") {
      return { model: data.model, thinking: data.thinking };
    }
  }
  return undefined;
}

/** A message of the Turn's conversation, native or display, as the runtime would rebuild it. */
type ConversationMessage =
  | { native: true; role: string; stopReason?: string; toolCalls: number }
  | { native: false; type: string; stopReason?: string };

const DISPLAY_MESSAGES = new Set(["agent.message", "agent.thinking", "agent.tool_use", "agent.mcp_tool_use",
  "agent.tool_result", "agent.mcp_tool_result", "subagent.instruction"]);

/**
 * The Turn's last conversation message. A compaction boundary and other native
 * entries are not messages: Pi compacts after a final answer as well as after
 * a failed request, and the message before the boundary says which it was.
 */
function lastMessage(output: readonly StoredEvent[]): ConversationMessage | undefined {
  let last: ConversationMessage | undefined;
  for (const event of output) {
    const data = event.data as { entry?: { type?: string; message?: { role?: string; stopReason?: string; content?: unknown } }; stopReason?: unknown } | null;
    if (event.type === "agent.context_entry") {
      const entry = data?.entry;
      if (entry?.type === "custom_message") last = { native: true, role: "custom", toolCalls: 0 };
      else if (entry?.type === "message" && entry.message?.role) {
        const content = Array.isArray(entry.message.content) ? entry.message.content as Array<{ type?: unknown }> : [];
        last = { native: true, role: entry.message.role, stopReason: entry.message.stopReason,
          toolCalls: content.filter((block) => block.type === "toolCall").length };
      }
    } else if (DISPLAY_MESSAGES.has(event.type)) {
      last = { native: false, type: event.type, ...(typeof data?.stopReason === "string" ? { stopReason: data.stopReason } : {}) };
    }
  }
  return last;
}

/**
 * Whether the Turn's history holds its input. Pi claims the input with
 * agent.context_start right before it prompts and commits it as its native
 * user message; until then, only prompting the input again starts the Turn.
 * A runtime without a native chain records only display output, which follows
 * the input it answers.
 */
function inputCommitted(output: readonly StoredEvent[], last: ConversationMessage | undefined): boolean {
  if (output.some((event) => event.type === "agent.context_entry" &&
    (event.data as { entry?: { type?: string; message?: { role?: string } } } | null)?.entry?.message?.role === "user")) return true;
  return last !== undefined && !output.some((event) => event.type === "agent.context_start");
}

/** The Agent's last word: an assistant message that requests no tool and whose request did not fail. */
function isFinalAnswer(message: ConversationMessage): boolean {
  if (message.stopReason === "error" || message.stopReason === "aborted") return false;
  return message.native ? message.role === "assistant" && message.toolCalls === 0 : message.type === "agent.message";
}

/**
 * Where an attempt of `turnId` starts, from the Turn's committed events: after
 * the model steps it made, which count against its step budget, and after its
 * highest output block. One count for every Turn, whether it answers an input,
 * runs a Child execution or resumes a wait.
 */
export function turnProgress(events: readonly StoredEvent[], turnId: string): AdapterResume {
  const committed = events.filter((event) => (event.data as { turnId?: unknown } | null)?.turnId === turnId);
  return {
    completedModelSteps: committed.filter((event) => event.type === "span.model_request_start").length,
    blockBase: 1 + Math.max(-1, ...committed.flatMap((event) => presentEvent(event))
      .map((event) => (event.data as { blockIndex?: number } | null)?.blockIndex ?? -1)),
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
