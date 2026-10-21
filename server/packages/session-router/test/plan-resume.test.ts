import { describe, expect, it } from "vitest";
import type { DelegationExecution, DelegationWait, PendingEventClaimEnd, StoredEvent } from "@oma-server/store";
import { outcomeFromEvents } from "../src/delegation-coordinator.js";
import { planResume, turnProgress, type DanglingToolCall, type ResumeFacts, type ResumePlan, type RunPlan } from "../src/plan-resume.js";

/** The claimed input, promoted at seq 10 and claimed by generation 2. */
const INPUT = "pevt_input";
const PROMOTED_SEQ = 10;
/** The Turn the input's first attempt started: every later attempt continues it under this id. */
const TURN = "turn_10_a1";
/** This attempt's own id, the Turn's name when no earlier attempt named one. */
const NEW_TURN = "turn_10_a2";

type Logged = [type: string, data?: Record<string, unknown>];

/** Events after the promoted input, in seq order; a native entry reserves a seq per display block. */
function log(...events: Logged[]): StoredEvent[] {
  let seq = PROMOTED_SEQ;
  return events.map(([type, data = {}]) => {
    const blocks = (data.presentation as { blocks?: unknown[] } | undefined)?.blocks?.length ?? 0;
    seq += blocks + 1;
    return { sessionId: "sess", seq, type, data, ts: new Date(0), sessionThreadId: "sthr_primary" };
  });
}

function facts(overrides: Partial<ResumeFacts> = {}): ResumeFacts {
  return { pendingEventId: INPUT, promotedSeq: PROMOTED_SEQ, claim: { generation: 2, priorInterrupt: false, previous: "expired" }, events: [], waits: [], ...overrides };
}

/** The facts of a claim whose predecessor accepted an Interrupt and stopped before it took effect. */
const afterInterrupt = (overrides: Partial<ResumeFacts> = {}): ResumeFacts =>
  facts({ claim: { generation: 2, priorInterrupt: true, previous: "expired" }, ...overrides });

const running: Logged = ["session.status_running", {}];
const completed: Logged = ["session.turn_completed", { pendingEventId: INPUT, turnId: "turn_10_a1" }];
/** The model and thinking Pi resolved when the Turn's first attempt claimed the input. */
const PINNED = { model: "provider/first-model", thinking: "high" };
const contextStart: Logged = ["agent.context_start", { sdk: "pi@0.83.0", inputEventId: "sess:10", turnId: "turn_10_a1", ...PINNED }];
/** Pi's native user message: the input, committed into the Turn's native chain. */
const userEntry: Logged = ["agent.context_entry", { id: "evt_user", sdk: "pi@0.83.0", turnId: "turn_10_a1", inputEventId: "sess:10",
  entry: { id: "entry_user", type: "message", parentId: null, message: { role: "user", content: [{ type: "text", text: "go" }] } },
  presentation: { version: 1, blocks: [] } }];
/** The start of a Turn whose input Pi committed. */
const started: Logged[] = [running, contextStart, userEntry];

type NativeBlock = { type: "text"; text: string } | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
const text = (value: string): NativeBlock => ({ type: "text", text: value });
const call = (id: string, name = "bash", args: Record<string, unknown> = {}): NativeBlock => ({ type: "toolCall", id, name, arguments: args });

/**
 * A native Pi assistant entry. Its presentation selects a display block per
 * content block, as Pi records it: an MCP gateway call names its tool and
 * server, and a call whose arguments never finished also gets its result.
 */
function assistant(blocks: NativeBlock[], options: { stopReason?: string; mcp?: Record<string, { name: string; serverName: string }>; blockIndex?: number } = {}): Logged {
  const stopReason = options.stopReason ?? (blocks.some((block) => block.type === "toolCall") ? "toolUse" : "stop");
  const presentation = blocks.flatMap((block, index) => {
    if (block.type === "text") return [{ type: "agent.message", index }];
    const mcp = options.mcp?.[block.id];
    const use = mcp ? { type: "agent.mcp_tool_use", index, ...mcp } : { type: "agent.tool_use", index };
    return stopReason === "aborted" || stopReason === "error"
      ? [use, { type: mcp ? "agent.mcp_tool_result" : "agent.tool_result", index, ...(mcp ? { serverName: mcp.serverName } : {}), unexecuted: stopReason }]
      : [use];
  }).map((display, position) => options.blockIndex === undefined ? display : { ...display, blockIndex: options.blockIndex + position });
  return ["agent.context_entry", { id: "evt_assistant", sdk: "pi@0.83.0", turnId: "turn_10_a1",
    entry: { id: "entry_assistant", type: "message", parentId: null, message: { role: "assistant", content: blocks, stopReason } },
    presentation: { version: 1, blocks: presentation } }];
}

/** A native Pi toolResult entry answering one call. */
function nativeResult(toolCallId: string, serverName?: string): Logged {
  return ["agent.context_entry", { id: `evt_result_${toolCallId}`, sdk: "pi@0.83.0", turnId: "turn_10_a1",
    entry: { id: `entry_result_${toolCallId}`, type: "message", parentId: "entry_assistant",
      message: { role: "toolResult", toolCallId, content: [{ type: "text", text: "ok" }], isError: false } },
    presentation: { version: 1, blocks: [serverName ? { type: "agent.mcp_tool_result", serverName } : { type: "agent.tool_result" }] } }];
}

/** Native entries that are not messages of the conversation, and steering. */
const compaction: Logged = ["agent.context_entry", { id: "evt_compaction", sdk: "pi@0.83.0", turnId: "turn_10_a1",
  entry: { id: "entry_compaction", type: "compaction", parentId: "entry_assistant", summary: "earlier work", firstKeptEntryId: "entry_user" } }];
const steering: Logged = ["agent.context_entry", { id: "evt_instruction", sdk: "pi@0.83.0", turnId: "turn_10_a1",
  entry: { id: "entry_instruction", type: "custom_message", parentId: "entry_result_call_1", customType: "subagent.instruction",
    content: [{ type: "text", text: "verify first" }], display: true, details: { instructionId: "cmd_1" } } }];

/** Display events, as older histories, the mock runtime and the Router's own repairs record them. */
const toolUse = (toolUseId: string, name = "bash"): Logged => ["agent.tool_use", { toolUseId, name, input: {}, turnId: "turn_10_a1" }];
const mcpToolUse = (toolUseId: string, name: string, serverName?: string): Logged =>
  ["agent.mcp_tool_use", { toolUseId, name, ...(serverName ? { serverName } : {}), input: {}, turnId: "turn_10_a1" }];
const toolResult = (toolUseId: string): Logged => ["agent.tool_result", { toolUseId, content: [], isError: true, turnId: "turn_10_a1" }];
const message = (value: string, stopReason?: string): Logged => ["agent.message", { content: [{ type: "text", text: value }], ...(stopReason ? { stopReason } : {}), turnId: "turn_10_a1" }];
const sessionError = (code: string): Logged => ["session.error", { error: { code, message: code } }];

/** A Turn that committed no model step and no output block starts at the first of each. */
const FIRST_STEP = { completedModelSteps: 0, blockBase: 0 };
const bash = (toolUseId: string): DanglingToolCall => ({ type: "agent.tool_use", toolUseId, name: "bash", input: {} });
const agentCall = (toolUseId: string): DanglingToolCall => ({ type: "agent.tool_use", toolUseId, name: "Agent", input: {} });
/** The takeover an expired claim makes: every call without a result, as the Turn moved. */
const expired = (...danglingToolUseIds: string[]) => ({ reason: "expired" as const, danglingToolUseIds });

const ended = (repairs: DanglingToolCall[] = [], options: { turnId?: string; repairOutcome?: "unknown" | "interrupted" } = {}): ResumePlan => ({
  kind: "complete", cause: "turn_ended", turnId: options.turnId ?? TURN, repairs, repairOutcome: options.repairOutcome ?? "unknown",
  interruptChildren: true, takeover: expired(...repairs.map((repair) => repair.toolUseId)) });
const interrupted = (repairs: DanglingToolCall[] = [], turnId = TURN): ResumePlan => ({ kind: "complete", cause: "interrupted", turnId, repairs,
  repairOutcome: "interrupted", interruptChildren: true, takeover: expired(...repairs.map((repair) => repair.toolUseId)) });
const answered = (repairs: DanglingToolCall[] = []): ResumePlan => ({ kind: "complete", cause: "answered", turnId: TURN, repairs,
  repairOutcome: "unknown", interruptChildren: false, takeover: expired(...repairs.map((repair) => repair.toolUseId)) });
/** Prompt the input in the Turn its first attempt named, or in this attempt's own when none did. */
const prompt = (turnId = TURN): RunPlan => ({ kind: "run", start: "prompt", turnId, progress: FIRST_STEP, repairs: [], waits: [],
  takeover: expired() });
/** Continue the committed native history, after an "outcome unknown" result for each call that has none. */
const resumed = (repairs: DanglingToolCall[] = [], progress = FIRST_STEP): RunPlan => ({ kind: "run", start: "continue", turnId: TURN, progress,
  repairs, waits: [], takeover: expired(...repairs.map((repair) => repair.toolUseId)) });

/** A plan that runs the Turn with the model and thinking its first attempt ran with (#253). */
const pinned = (plan: RunPlan): RunPlan => ({ ...plan, config: PINNED });

/** The Turn an earlier attempt started and left waiting on a synchronous delegation. */
const WAITING_TURN = "turn_10_a1";
function wait(callerToolUseId: string, status: DelegationWait["status"] = "waiting", callerTurnId = WAITING_TURN): DelegationWait {
  return { tenantId: "tenant", callerSessionId: "sess", callerTurnId, callerToolUseId, executionId: `exec_${callerToolUseId}`,
    parentPendingEventId: INPUT, config: { model: "provider/model", thinking: "low" }, status };
}
const CONFIG = { model: "provider/model", thinking: "low" };
const modelRequest: Logged = ["span.model_request_start", { turnId: WAITING_TURN }];
const delegationResult = (toolUseId: string): Logged => ["agent.tool_result", { toolUseId, content: [], isError: false, turnId: WAITING_TURN }];

/** The marker the takeover of `generation` recorded: how the claim before it ended, and the calls it found dangling. */
const takenOver = (reason: PendingEventClaimEnd, generation: number, ...danglingToolUseIds: string[]): Logged =>
  ["session.turn_resumed", { turnId: TURN, generation, reason, danglingToolUseIds }];
/** A takeover after the Runner holding the Turn was lost: its lease expired. */
const lost = (generation: number, ...dangling: string[]) => takenOver("expired", generation, ...dangling);
/** A takeover after the Runner holding the Turn released it: a handoff, or a Turn left waiting. */
const handedOver = (generation: number, ...dangling: string[]) => takenOver("released", generation, ...dangling);
/** The claim of `generation`, whose predecessor ended as `previous`, over `events`. */
const claimed = (generation: number, previous: PendingEventClaimEnd, events: Logged[], overrides: Partial<ResumeFacts> = {}): ResumeFacts =>
  facts({ claim: { generation, priorInterrupt: false, previous }, events: log(...events), ...overrides });
/** Continue the committed native history of a Turn the Runner holding it handed over. */
const continuedAfterHandoff: RunPlan = { kind: "run", start: "continue", turnId: TURN, progress: FIRST_STEP, repairs: [], waits: [],
  takeover: { reason: "released", danglingToolUseIds: [] } };
/** End the Turn instead of continuing it once more: repair its calls, record recovery_limit_exceeded, stop its children. */
const stalled = (repairs: DanglingToolCall[] = [], turnId = TURN): ResumePlan => ({ kind: "complete", cause: "stalled", turnId, repairs,
  repairOutcome: "unknown", interruptChildren: true,
  error: { phase: "recovery_limit_exceeded", code: "recovery_limit_exceeded", message: expect.any(String) as string },
  takeover: expired(...repairs.map((repair) => repair.toolUseId)) });

/** Every row plans an input that runs no Child execution, or one that has not ended. */
const rows: Array<[string, ResumeFacts, ResumePlan]> = [
  ["A13 turn_completed committed, input not acknowledged: acknowledge only",
    facts({ events: log(running, ["agent.message", { content: [] }], completed) }),
    { kind: "acknowledge", turnId: TURN }],
  // No earlier attempt named the Turn, so this attempt's id names it.
  ["A1/A2 nothing after the promoted input: prompt the input in a Turn of its own",
    facts(),
    prompt(NEW_TURN)],
  ["A3 only the running status: prompt the input",
    facts({ events: log(running) }),
    prompt(NEW_TURN)],
  ["a Delegation Result notification is no output of the Turn: prompt the input",
    facts({ events: log(running, ["subagent.result", { executionId: "exec_async", callerTurnId: "turn_4_a1" }]) }),
    prompt(NEW_TURN)],
  // A lost takeover's marker names the Turn the next takeover continues.
  ["a lost takeover that committed only its marker: prompt the input in the Turn the marker names",
    facts({ events: log(running, ["session.turn_resumed", { turnId: TURN, generation: 1, reason: "expired", danglingToolUseIds: [] }]) }),
    prompt()],

  ["A12 session.error committed: repair the dangling call as unknown and complete",
    facts({ events: log(running, toolUse("call_1"), sessionError("adapter_error")) }),
    ended([bash("call_1")])],
  ["A12/D3 turn_aborted committed: complete, nothing dangles",
    facts({ events: log(...started, assistant([call("call_1")]), nativeResult("call_1"), ["session.turn_aborted", { turnId: "turn_10_a1" }]) }),
    ended([], { repairOutcome: "interrupted" })],
  ["A12 an Interrupted Turn's last repair is missing after turn_aborted: repair it as interrupted",
    facts({ events: log(running, toolUse("call_1"), ["session.turn_aborted", { turnId: "turn_10_a1" }]) }),
    ended([bash("call_1")], { repairOutcome: "interrupted" })],
  ["A12 status_idle committed without a completion marker: complete",
    facts({ events: log(running, ["agent.message", { content: [], turnId: TURN }], ["session.status_idle", {}]) }),
    ended()],
  ["A12 turn_aborted committed before any output: complete the Turn it names",
    facts({ events: log(running, ["session.turn_aborted", { turnId: TURN }]) }),
    ended([], { repairOutcome: "interrupted" })],

  ["A4 context_start committed, native user message not: prompt the input again in the same Turn",
    facts({ events: log(running, contextStart) }),
    pinned(prompt())],
  ["B1 compaction summary in flight before the input was committed: prompt again in the same Turn",
    facts({ events: log(running, contextStart, ["agent.context_usage", { turnId: TURN, tokens: 900 }], ["agent.compaction", { turnId: TURN, status: "started" }]) }),
    pinned(prompt())],
  ["B2 compaction boundary committed before the input: prompt again on top of it",
    facts({ events: log(running, contextStart, compaction) }),
    pinned(prompt())],
  ["A5 native user message committed, model request in flight: continue",
    facts({ events: log(...started) }),
    pinned(resumed())],
  ["A6/A7 native tool call committed, its result not: unknown result, continue",
    facts({ events: log(...started, modelRequest, assistant([text("running it"), call("call_1")], { blockIndex: 0 })) }),
    pinned(resumed([bash("call_1")], { completedModelSteps: 1, blockBase: 2 }))],
  ["A8 parallel native tool calls, one result committed: unknown result only for the other",
    facts({ events: log(...started, assistant([call("call_1"), call("call_2"), call("call_3")]), nativeResult("call_2")) }),
    pinned(resumed([bash("call_1"), bash("call_3")]))],
  ["A9 every native tool result committed: continue, nothing to repair",
    facts({ events: log(...started, assistant([call("call_1"), call("call_2")]), nativeResult("call_1"), nativeResult("call_2")) }),
    pinned(resumed())],
  ["A10 final answer committed without a completion marker: complete without a model request",
    facts({ events: log(...started, assistant([call("call_1")]), nativeResult("call_1"), assistant([text("done")])) }),
    answered()],
  ["A10/B1 threshold compaction after the final answer, summary uncommitted: complete as answered",
    facts({ events: log(...started, assistant([text("done")]), ["agent.compaction", { turnId: TURN, status: "started" }]) }),
    answered()],
  ["A10/B2 compaction boundary committed after the final answer: complete as answered",
    facts({ events: log(...started, assistant([text("done")]), compaction) }),
    answered()],
  ["A10 a final answer cut short by the length limit is final",
    facts({ events: log(...started, assistant([text("long")], { stopReason: "length" })) }),
    answered()],
  ["A11 aborted assistant whose call never got its arguments: answered by its own entry, continue",
    facts({ events: log(...started, assistant([text("half"), call("call_1")], { stopReason: "aborted" })) }),
    pinned(resumed())],
  ["A11 failed model request is last: continue",
    facts({ events: log(...started, assistant([text("")], { stopReason: "error" })) }),
    pinned(resumed())],
  ["B3 overflow compaction committed after the failed request: continue from the compacted context",
    facts({ events: log(...started, assistant([text("")], { stopReason: "error" }), compaction) }),
    pinned(resumed())],
  ["C9 steering committed at the request gate: continue",
    facts({ events: log(...started, assistant([call("call_1")]), nativeResult("call_1"), steering) }),
    pinned(resumed())],
  ["A15 MCP tool calls dangling: unknown results with the server they name",
    facts({ events: log(...started,
      assistant([call("call_native", "mcp")], { mcp: { call_native: { name: "search", serverName: "docs" } } }),
      mcpToolUse("call_display", "lookup")) }),
    pinned(resumed([
      { type: "agent.mcp_tool_use", toolUseId: "call_native", name: "search", serverName: "docs", input: {} },
      { type: "agent.mcp_tool_use", toolUseId: "call_display", name: "lookup", input: {} },
    ]))],
  ["A17 a lost takeover wrote some repairs: repair only the rest, continue",
    facts({ events: log(...started, assistant([call("call_1"), call("call_2")]),
      ["session.turn_resumed", { turnId: TURN, generation: 1, reason: "expired", danglingToolUseIds: ["call_1", "call_2"] }], toolResult("call_1")) }),
    pinned(resumed([bash("call_2")]))],
  ["A17 a lost takeover wrote every repair: continue from the repaired results",
    facts({ events: log(...started, assistant([call("call_1")]), toolResult("call_1")) }),
    pinned(resumed())],
  ["a call recorded twice is repaired once",
    facts({ events: log(running, toolUse("call_1"), toolUse("call_1")) }),
    resumed([bash("call_1")])],
  // A runtime without a native chain (the mock, older histories) commits display output only.
  ["display output with a dangling call: unknown result, continue",
    facts({ events: log(running, message("running it"), toolUse("call_1")) }),
    resumed([bash("call_1")])],
  ["display output ending in a final message: complete as answered",
    facts({ events: log(running, toolUse("call_1"), toolResult("call_1"), message("done")) }),
    answered()],
  ["display output ending in a message cut short: continue",
    facts({ events: log(running, message("half", "aborted")) }),
    resumed()],

  ["C1/C5 synchronous wait accepted, child still running: resume the wait in its Turn, then continue",
    facts({ waits: [wait("call_agent")], events: log(...started, modelRequest,
      assistant([text("delegating"), call("call_agent", "Agent")], { blockIndex: 0 }), ["session.status_waiting", { turnId: WAITING_TURN }]) }),
    { kind: "run", start: "continue", turnId: WAITING_TURN, progress: { completedModelSteps: 1, blockBase: 2 }, repairs: [],
      waits: [wait("call_agent")], config: CONFIG, takeover: expired("call_agent") }],
  ["a wait whose Turn committed no model step yet: resume it from the first step",
    facts({ waits: [wait("call_agent")], events: log(...started) }),
    { kind: "run", start: "continue", turnId: WAITING_TURN, progress: FIRST_STEP, repairs: [],
      waits: [wait("call_agent")], config: CONFIG, takeover: expired() }],
  ["C2 the wait's result was consumed, the Turn not continued: resume it",
    facts({ waits: [wait("call_agent", "consumed")], events: log(...started, modelRequest,
      assistant([call("call_agent", "Agent")], { blockIndex: 0 }), delegationResult("call_agent")) }),
    { kind: "run", start: "continue", turnId: WAITING_TURN, progress: { completedModelSteps: 1, blockBase: 1 }, repairs: [],
      waits: [wait("call_agent", "consumed")], config: CONFIG, takeover: expired() }],
  ["a resumed wait whose sibling call has no result: resume the wait, unknown result for the sibling, continue",
    facts({ waits: [wait("call_agent")], events: log(...started, modelRequest,
      assistant([call("call_agent", "Agent"), call("call_bash")], { blockIndex: 0 })) }),
    { kind: "run", start: "continue", turnId: WAITING_TURN, progress: { completedModelSteps: 1, blockBase: 2 }, repairs: [bash("call_bash")],
      waits: [wait("call_agent")], config: CONFIG, takeover: expired("call_agent", "call_bash") }],
  ["a cancelled wait is not resumed",
    facts({ waits: [wait("call_old", "cancelled", "turn_10_a0"), wait("call_agent")], events: log(...started) }),
    { kind: "run", start: "continue", turnId: WAITING_TURN, progress: FIRST_STEP, repairs: [],
      waits: [wait("call_agent")], config: CONFIG, takeover: expired() }],
  ["only cancelled waits: the Turn has nothing to resume, its call gets an unknown result",
    facts({ waits: [wait("call_agent", "cancelled")], events: log(...started, assistant([call("call_agent", "Agent")])) }),
    pinned(resumed([agentCall("call_agent")]))],
  ...["session.status_idle", "session.error", "session.turn_aborted"].map((type): [string, ResumeFacts, ResumePlan] => [
    `A12 ${type} committed after a consumed wait: complete the waiting Turn, do not resume it`,
    facts({ waits: [wait("call_agent", "consumed")], events: log(...started, assistant([call("call_agent", "Agent")]),
      delegationResult("call_agent"), toolUse("call_bash"), [type, { turnId: WAITING_TURN, error: { code: "adapter_error" } }]) }),
    ended([bash("call_bash")], { turnId: WAITING_TURN, repairOutcome: type === "session.turn_aborted" ? "interrupted" : "unknown" })]),
  ["C3 Agent tool call committed, delegation not accepted: no wait, unknown result, continue",
    facts({ events: log(...started, assistant([call("call_agent", "Agent")])) }),
    pinned(resumed([agentCall("call_agent")]))],
  // Whether a record answers a delegation call is its resolver's to find (#251): the plan knows no tool.
  ["C4–C6 dangling delegation calls: repaired as any call is, with the arguments their resolvers read",
    facts({ events: log(...started, assistant([
      call("call_agent", "Agent", { prompt: "triage", run_in_background: true }),
      call("call_peek", "get_subagent_result", { childId: "sess_child", wait: false }),
      call("call_steer", "steer_subagent", { childId: "sess_child", message: "also the closed ones" }),
    ])) }),
    pinned(resumed([
      { type: "agent.tool_use", toolUseId: "call_agent", name: "Agent", input: { prompt: "triage", run_in_background: true } },
      { type: "agent.tool_use", toolUseId: "call_peek", name: "get_subagent_result", input: { childId: "sess_child", wait: false } },
      { type: "agent.tool_use", toolUseId: "call_steer", name: "steer_subagent", input: { childId: "sess_child", message: "also the closed ones" } },
    ]))],

  // An Interrupt an earlier generation accepted ends the Turn as an Interrupted
  // Turn once the log neither completes nor ends it, before any other row. It
  // ends the Turn the first attempt named; one nothing named is this attempt's.
  ["D1 Interrupt accepted, Runner lost before the Turn committed output: Interrupted Turn, not run",
    afterInterrupt({ events: log(running) }),
    interrupted([], NEW_TURN)],
  ["D1 Interrupt accepted, Runner lost before even the running status: Interrupted Turn, not run",
    afterInterrupt(),
    interrupted([], NEW_TURN)],
  ["D1 Interrupt accepted while a native tool call ran: repair it, Interrupted Turn",
    afterInterrupt({ events: log(...started, assistant([text("running it"), call("call_1")])) }),
    interrupted([bash("call_1")])],
  ["D1 Interrupt accepted during parallel tools: repair only the call without a result",
    afterInterrupt({ events: log(...started, assistant([call("call_1"), call("call_2")]), nativeResult("call_2")) }),
    interrupted([bash("call_1")])],
  ["D1 Interrupt accepted after the final answer was committed: Interrupted Turn, not completed as answered",
    afterInterrupt({ events: log(...started, assistant([text("done")])) }),
    interrupted()],
  ["D1 Interrupt accepted after a compaction boundary: Interrupted Turn",
    afterInterrupt({ events: log(running, contextStart, compaction) }),
    interrupted()],
  ["D1/C12 Interrupt accepted while the Turn waits on a delegation: the waiting Turn ends interrupted, not resumed",
    afterInterrupt({ waits: [wait("call_agent")], events: log(...started, modelRequest,
      assistant([text("delegating"), call("call_agent", "Agent")], { blockIndex: 0 }), ["session.status_waiting", { turnId: WAITING_TURN }]) }),
    interrupted([agentCall("call_agent")], WAITING_TURN)],
  ["D3 Interrupt accepted, lost while writing its repairs: repair only the rest, Interrupted Turn",
    afterInterrupt({ events: log(running, toolUse("call_1"), toolUse("call_2"), toolResult("call_1")) }),
    interrupted([bash("call_2")])],
  ["D3 Interrupt accepted, lost after turn_aborted: the log ends the Turn, complete it",
    afterInterrupt({ events: log(running, assistant([call("call_1")]), toolUse("call_2"), toolResult("call_1"),
      ["session.turn_aborted", { turnId: "turn_10_a1" }]) }),
    ended([bash("call_2")], { repairOutcome: "interrupted" })],
  ["D1 a session.error committed before the Interrupt took effect: the log ends the Turn, complete it",
    afterInterrupt({ events: log(running, sessionError("adapter_error")) }),
    ended([], { turnId: NEW_TURN })],
  ["A13 Interrupt accepted after turn_completed was committed: acknowledge only",
    afterInterrupt({ events: log(running, ["agent.message", { content: [] }], completed) }),
    { kind: "acknowledge", turnId: TURN }],

  // The takeover limit (#250): a Turn whose Runner is lost again and again
  // without the Turn committing progress is ended by the fourth such takeover.
  ["E1 three expired takeovers committed no native message and this claim expired too: recovery_limit_exceeded, complete",
    claimed(5, "expired", [...started, modelRequest, lost(2), modelRequest, lost(3), modelRequest, lost(4), modelRequest]),
    stalled()],
  ["E1 the third expired takeover without progress still continues the Turn",
    claimed(4, "expired", [...started, lost(2), lost(3)]),
    pinned(resumed())],
  ["E1 a call the lost attempts left dangling is repaired as unknown when the limit ends the Turn",
    claimed(5, "expired", [...started, assistant([call("call_1")]), lost(2, "call_1"), lost(3, "call_1"), lost(4, "call_1")]),
    stalled([bash("call_1")])],
  ["E1 a Turn whose input was never committed is ended by the limit as well",
    claimed(5, "expired", [running, contextStart, lost(2), lost(3), lost(4)]),
    stalled()],
  ["E1 the takeover that ended the Turn was lost before its completion: the log ends the Turn, complete it",
    claimed(6, "expired", [...started, lost(2), lost(3), lost(4), lost(5), sessionError("recovery_limit_exceeded")]),
    ended()],
  ["E1 the limit outranks a final answer whose completion the lost attempts never committed",
    claimed(5, "expired", [...started, assistant([text("done")]), lost(2), lost(3), lost(4)]),
    stalled()],
  ["E1 the limit outranks a resumed wait: the waiting Turn ends and its synchronous children are stopped",
    claimed(5, "expired", [...started, assistant([call("call_agent", "Agent")]), lost(2, "call_agent"), lost(3, "call_agent"), lost(4, "call_agent")],
      { waits: [wait("call_agent")] }),
    stalled([agentCall("call_agent")], WAITING_TURN)],
  ["E1 an Interrupt the lost attempts accepted outranks the limit: Interrupted Turn",
    claimed(5, "expired", [...started, lost(2), lost(3), lost(4)], { claim: { generation: 5, priorInterrupt: true, previous: "expired" } }),
    interrupted()],
  ["E1 a completed Turn is only acknowledged, whatever its takeovers",
    claimed(5, "expired", [...started, lost(2), lost(3), lost(4), completed]),
    { kind: "acknowledge", turnId: TURN }],

  ["E2 an answer committed after the takeovers resets the count: continue the Turn",
    claimed(5, "expired", [...started, lost(2), lost(3), lost(4), assistant([call("call_1")]), nativeResult("call_1")]),
    pinned(resumed())],
  ["E2 an answer requesting a tool after the takeovers resets the count: unknown result, continue",
    claimed(5, "expired", [...started, lost(2), lost(3), lost(4), assistant([call("call_1")])]),
    pinned(resumed([bash("call_1")]))],
  ["E2 a failed model request is no progress: the limit still ends the Turn",
    claimed(5, "expired", [...started, lost(2), assistant([text("")], { stopReason: "error" }), lost(3), lost(4)]),
    stalled()],
  ["E2 a compaction boundary is no progress: the limit still ends the Turn",
    claimed(5, "expired", [...started, assistant([text("")], { stopReason: "error" }), lost(2), compaction, lost(3), lost(4)]),
    stalled()],
  ["E2 the takeovers' own repairs are no progress: the limit still ends the Turn",
    claimed(5, "expired", [...started, assistant([call("call_1")]), lost(2, "call_1"), toolResult("call_1"), lost(3), lost(4)]),
    stalled()],

  ["E3 a released claim is not counted: three losses, then a handoff, continue",
    claimed(5, "released", [...started, lost(2), lost(3), lost(4)]),
    pinned(continuedAfterHandoff)],
  ["E3 handoffs without progress never end the Turn",
    claimed(6, "released", [...started, handedOver(2), handedOver(3), handedOver(4), handedOver(5)]),
    pinned(continuedAfterHandoff)],
  ["E3/F7 a handoff between losses neither counts nor resets the count: the fourth loss ends the Turn",
    claimed(6, "expired", [...started, lost(2), lost(3), handedOver(4), lost(5)]),
    stalled()],
  ["F7 a handoff, then the new owner is lost: one loss, continue",
    claimed(3, "expired", [...started, handedOver(2)]),
    pinned(resumed())],
  ["E3 a Turn released while it waits on a delegation is not counted: resume the wait",
    claimed(5, "expired", [...started, modelRequest, assistant([text("delegating"), call("call_agent", "Agent")], { blockIndex: 0 }),
      lost(2, "call_agent"), lost(3, "call_agent"), handedOver(4, "call_agent")], { waits: [wait("call_agent")] }),
    { kind: "run", start: "continue", turnId: WAITING_TURN, progress: { completedModelSteps: 1, blockBase: 2 }, repairs: [],
      waits: [wait("call_agent")], config: CONFIG, takeover: expired("call_agent") }],
];

/** The Child execution of the input, as starting it under the new claim left it. */
const CHILD_TURN = "turn_3_a1";
const executionEnded = (turnId: string): ResumePlan => ({
  kind: "complete", cause: "execution_ended", turnId, repairs: [], repairOutcome: "unknown", interruptChildren: false, takeover: expired() });
/** A running Child execution the parent asked to stop before this claim: its Interrupt never took effect. */
const stopRequested = { status: "running", turnId: CHILD_TURN, interruptRequested: true } as const;
const executionRows: Array<[string, ResumeFacts, ResumePlan]> = [
  ["the Child execution ended before its Turn's completion marker: complete, nothing to add",
    facts({ execution: { status: "completed", turnId: CHILD_TURN }, events: log(...started, assistant([text("done")])) }),
    executionEnded(CHILD_TURN)],
  // Only a session.error in its log ends an execution as recovery_required (#250): the log says it already.
  ["an execution the takeover limit ended before its completion marker: complete, nothing to add",
    facts({ execution: { status: "recovery_required", turnId: CHILD_TURN, result: { status: "recovery_required", reason: "limit", output: "",
      trace: { sessionId: "sess", turnId: CHILD_TURN } } }, events: log(running, toolUse("call_1"), toolResult("call_1"), sessionError("recovery_limit_exceeded")) }),
    executionEnded(CHILD_TURN)],
  ["a Child execution that ended without running completes this attempt's Turn",
    facts({ execution: { status: "interrupted" } }),
    executionEnded(NEW_TURN)],
  ["A13 a completed Turn is only acknowledged, whatever its Child execution",
    facts({ execution: { status: "completed", turnId: CHILD_TURN }, events: log(running, completed) }),
    { kind: "acknowledge", turnId: TURN }],
  ["D1 a Child execution that has ended outranks the Interrupt its lost owner accepted",
    afterInterrupt({ execution: { status: "completed", turnId: CHILD_TURN }, events: log(...started, assistant([text("done")])) }),
    executionEnded(CHILD_TURN)],
  ["C12 the parent asked to stop the Child execution and its owner was lost mid-tool: repair, Interrupted Turn",
    facts({ execution: stopRequested, events: log(...started, assistant([text("running it"), call("call_1")])) }),
    interrupted([bash("call_1")])],
  ["C12 the parent asked to stop the Child execution after its final answer was committed: Interrupted Turn",
    facts({ execution: stopRequested, events: log(...started, assistant([text("done")])) }),
    interrupted()],
  ["C12 the stop took effect before the owner was lost: the log ends the Turn, complete it",
    facts({ execution: stopRequested, events: log(...started, assistant([call("call_1")]), ["session.turn_aborted", { turnId: TURN }]) }),
    ended([bash("call_1")], { repairOutcome: "interrupted" })],
];

describe("planResume", () => {
  it.each([...rows, ...executionRows])("%s", (_name, given, plan) => {
    expect(planResume(given)).toEqual(plan);
  });

  // The Router learns an execution's state by starting it, once the input is not to be acknowledged.
  // C7/C10: a running execution its lost owner left, now this claim's, continues like any Turn.
  it.each(rows)("a Child execution that has not ended changes no plan: %s", (_name, given, plan) => {
    for (const status of ["queued", "running"] as const) {
      expect(planResume({ ...given, execution: { status, turnId: CHILD_TURN, interruptRequested: false } })).toEqual(plan);
    }
  });
});

describe("the Turn an attempt continues", () => {
  // Every attempt of the input names the Turn its first attempt started, so
  // its repairs, errors and completion join that Turn's output.
  it.each([1, 2, 5])("generation %i of the input names the Turn the first attempt's events name", (generation) => {
    const given = facts({ claim: { generation, priorInterrupt: false, previous: "expired" }, events: log(running, contextStart, assistant([call("call_1")]), sessionError("adapter_error")) });
    expect(planResume(given)).toMatchObject({ kind: "complete", turnId: TURN });
  });

  it("an input no earlier attempt named is this attempt's Turn", () => {
    expect(planResume(facts({ claim: { generation: 3, priorInterrupt: false, previous: "expired" }, events: log(running, running) })))
      .toMatchObject({ kind: "run", start: "prompt", turnId: "turn_10_a3" });
  });

  // A Delegation Result notification names the Turns of the delegation, not this one.
  it("a Delegation Result notification never names the Turn", () => {
    const notification: Logged = ["subagent.result", { executionId: "exec_1", turnId: "turn_4_a1", callerTurnId: "turn_4_a1" }];
    expect(planResume(facts({ events: log(...started.slice(0, 1), notification, ...started.slice(1), assistant([text("half")])) })))
      .toMatchObject({ kind: "complete", cause: "answered", turnId: TURN });
  });
});

describe("the configuration a resumed Turn runs with", () => {
  // Editing the Agent's model or the Session's thinking changes only later Turns (#253).
  it("E5 a continued Turn runs with the model and thinking its first attempt recorded when it claimed the input", () => {
    expect(planResume(facts({ events: log(...started, modelRequest, assistant([call("call_1")])) })))
      .toMatchObject({ kind: "run", start: "continue", config: PINNED });
  });

  it("E5 a Turn prompted again runs with them too", () => {
    expect(planResume(facts({ events: log(running, contextStart) }))).toMatchObject({ kind: "run", start: "prompt", config: PINNED });
  });

  it("E5 the first attempt's configuration, not a later attempt's", () => {
    const later: Logged = ["agent.context_start", { sdk: "pi@0.83.0", inputEventId: "sess:10", turnId: TURN, model: "provider/edited", thinking: "off" }];
    expect(planResume(facts({ events: log(...started, assistant([call("call_1")]), nativeResult("call_1"), later) })))
      .toMatchObject({ kind: "run", start: "continue", config: PINNED });
  });

  it("E5 no attempt claimed the input yet: the Turn takes the configuration current when it starts", () => {
    expect(planResume(facts({ events: log(running) }))).not.toHaveProperty("config");
  });

  it("E5 a delegation wait's snapshot outranks the Turn's claim; what the wait lacks comes from the claim", () => {
    expect(planResume(facts({ waits: [wait("call_agent")], events: log(...started) }))).toMatchObject({ config: CONFIG });
    expect(planResume(facts({ waits: [{ ...wait("call_agent"), config: { model: "provider/model" } }], events: log(...started) })))
      .toMatchObject({ config: { model: "provider/model", thinking: PINNED.thinking } });
  });
});

describe("the takeover a plan records", () => {
  const halfway = log(...started, assistant([call("call_1"), call("call_2")]), nativeResult("call_2"));

  it("the input's first claim takes nothing over", () => {
    expect(planResume(facts({ claim: { generation: 1, priorInterrupt: false, previous: null } })))
      .toEqual({ kind: "run", start: "prompt", turnId: "turn_10_a1", progress: FIRST_STEP, repairs: [], waits: [] });
  });

  it("a Turn whose claim was released moves for a handoff, not a loss", () => {
    expect(planResume(facts({ claim: { generation: 2, priorInterrupt: false, previous: "released" }, events: halfway })))
      .toMatchObject({ kind: "run", start: "continue", takeover: { reason: "released", danglingToolUseIds: ["call_1"] } });
  });

  it("a Turn whose claim expired moves for a loss, with every call it left without a result", () => {
    expect(planResume(facts({ events: halfway })))
      .toMatchObject({ kind: "run", start: "continue", takeover: { reason: "expired", danglingToolUseIds: ["call_1"] } });
  });

  it("an acknowledgement takes no Turn over", () => {
    expect(planResume(facts({ events: log(running, completed) }))).not.toHaveProperty("takeover");
  });
});

describe("turnProgress", () => {
  // Two model steps and blocks 0..2 committed: a delegation call, its result, a final answer cut short.
  const steps: Logged[] = [modelRequest,
    assistant([text("delegating"), call("call_agent", "Agent")], { blockIndex: 0 }), ["session.status_waiting", { turnId: TURN }],
    delegationResult("call_agent"), modelRequest, assistant([text("half")], { blockIndex: 2, stopReason: "error" })];
  const committed = log(running, contextStart, ...steps);
  const EXPECTED = { completedModelSteps: 2, blockBase: 3 };

  it("A18 counts the model steps and output blocks the Turn committed", () => {
    expect(turnProgress(committed, TURN)).toEqual(EXPECTED);
  });

  it("A18 a Child execution's Turn counts the same as an ordinary Turn", () => {
    const child = committed.map((event) => event.type === "session.status_running" ? event
      : { ...event, data: { ...event.data as object, callerSessionId: "sess_parent", callerTurnId: "turn_2_a1", callerToolUseId: "call_7", executionId: "exec_7" } });
    expect(turnProgress(child, TURN)).toEqual(EXPECTED);
  });

  it("A18 a resumed wait continues from the same count", () => {
    expect(planResume(facts({ waits: [wait("call_agent", "consumed")], events: committed })))
      .toMatchObject({ kind: "run", turnId: TURN, progress: EXPECTED });
  });

  it("A18 a resumed ordinary Turn continues from the same count", () => {
    expect(planResume(facts({ events: log(...started, ...steps) })))
      .toMatchObject({ kind: "run", start: "continue", turnId: TURN, progress: EXPECTED });
  });

  it("output of another Turn does not count", () => {
    expect(turnProgress(committed, "turn_4_a1")).toEqual(FIRST_STEP);
  });
});

describe("a Child execution the takeover limit ends", () => {
  it("E1 gives its parent a recovery_required result that says why", () => {
    const plan = planResume(claimed(5, "expired", [...started, lost(2), lost(3), lost(4)]));
    if (plan.kind !== "complete" || !plan.error) throw new Error("The limit ends the Turn with an error");
    // The Router records the plan's error as the session.error that ends the Child's Turn.
    const childTurn = log(...started, lost(2), lost(3), lost(4),
      ["session.error", { turnId: TURN, error: { code: plan.error.code, message: plan.error.message } }]);
    const execution = { childId: "sess_child", turnId: TURN } as DelegationExecution;
    expect(outcomeFromEvents(execution, childTurn)).toEqual({ status: "recovery_required", reason: plan.error.message, output: "",
      trace: { sessionId: "sess_child", turnId: TURN } });
  });
});
