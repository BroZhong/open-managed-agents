import { describe, expect, it } from "vitest";
import type { DelegationWait, StoredEvent } from "@oma-server/store";
import { planResume, type DanglingToolCall, type ResumeFacts, type ResumePlan } from "../src/plan-resume.js";

/** The claimed input, promoted at seq 10 and claimed by generation 2. */
const INPUT = "pevt_input";
const PROMOTED_SEQ = 10;
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
  return { pendingEventId: INPUT, promotedSeq: PROMOTED_SEQ, claim: { generation: 2 }, events: [], waits: [], ...overrides };
}

const running: Logged = ["session.status_running", {}];
const completed: Logged = ["session.turn_completed", { pendingEventId: INPUT, turnId: "turn_10_a1" }];
const contextStart: Logged = ["agent.context_start", { sdk: "pi@0.83.0", inputEventId: "sess:10", turnId: "turn_10_a1" }];

type NativeBlock = { type: "text"; text: string } | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
const text = (value: string): NativeBlock => ({ type: "text", text: value });
const call = (id: string, name = "bash"): NativeBlock => ({ type: "toolCall", id, name, arguments: {} });

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

/** Display events, as older histories and the Router's own repairs record them. */
const toolUse = (toolUseId: string, name = "bash"): Logged => ["agent.tool_use", { toolUseId, name, input: {}, turnId: "turn_10_a1" }];
const mcpToolUse = (toolUseId: string, name: string, serverName?: string): Logged =>
  ["agent.mcp_tool_use", { toolUseId, name, ...(serverName ? { serverName } : {}), input: {}, turnId: "turn_10_a1" }];
const toolResult = (toolUseId: string): Logged => ["agent.tool_result", { toolUseId, content: [], isError: false, turnId: "turn_10_a1" }];
const sessionError = (code: string): Logged => ["session.error", { error: { code, message: code } }];

const PARTIAL = {
  phase: "recovery_partial_turn_aborted", code: "recovery_partial_turn_aborted",
  message: "A previous attempt stopped after committing partial output; it was not rerun to avoid mixing attempts.",
};
const ended = (repairs: DanglingToolCall[] = []): ResumePlan => ({ kind: "complete", cause: "turn_ended", turnId: NEW_TURN, repairs, interruptChildren: true });
const partial = (repairs: DanglingToolCall[] = []): ResumePlan => ({ kind: "complete", cause: "partial_output", turnId: NEW_TURN, repairs, error: PARTIAL, interruptChildren: false });
const bash = (toolUseId: string): DanglingToolCall => ({ type: "agent.tool_use", toolUseId, name: "bash" });

/** The Turn an earlier attempt started and left waiting on a synchronous delegation. */
const WAITING_TURN = "turn_10_a1";
function wait(callerToolUseId: string, status: DelegationWait["status"] = "waiting", callerTurnId = WAITING_TURN): DelegationWait {
  return { tenantId: "tenant", callerSessionId: "sess", callerTurnId, callerToolUseId, executionId: `exec_${callerToolUseId}`,
    parentPendingEventId: INPUT, config: { model: "provider/model", thinking: "low" }, status };
}
const modelRequest: Logged = ["span.model_request_start", { turnId: WAITING_TURN }];
const delegationResult = (toolUseId: string): Logged => ["agent.tool_result", { toolUseId, content: [], isError: false, turnId: WAITING_TURN }];
const UNSAFE = {
  phase: "unsafe_continuation", code: "recovery_required", turnId: WAITING_TURN,
  message: "A non-wait tool has an uncertain outcome. Inspect its external effects before continuing in a new Turn.",
};

/** Every row plans an input that runs no Child execution, or one that has not ended. */
const rows: Array<[string, ResumeFacts, ResumePlan]> = [
  ["A13 turn_completed committed, input not acknowledged: acknowledge only",
    facts({ events: log(running, ["agent.message", { content: [] }], completed) }),
    { kind: "acknowledge", turnId: NEW_TURN }],
  ["A1/A2 nothing after the promoted input: run a new Turn",
    facts(),
    { kind: "run", turnId: NEW_TURN }],
  ["A3 only the running status: run a new Turn",
    facts({ events: log(running) }),
    { kind: "run", turnId: NEW_TURN }],
  ["a Delegation Result notification is no output of the Turn: run a new Turn",
    facts({ events: log(running, ["subagent.result", { executionId: "exec_async" }]) }),
    { kind: "run", turnId: NEW_TURN }],

  ["A12 session.error committed: repair the dangling call and complete",
    facts({ events: log(running, toolUse("call_1"), sessionError("adapter_error")) }),
    ended([bash("call_1")])],
  ["A12/D3 turn_aborted committed: complete, nothing dangles",
    facts({ events: log(running, assistant([call("call_1")]), nativeResult("call_1"), ["session.turn_aborted", { turnId: "turn_10_a1" }]) }),
    ended()],
  ["A12 status_idle committed without a completion marker: complete",
    facts({ events: log(running, ["agent.message", { content: [] }], ["session.status_idle", {}]) }),
    ended()],

  // Until #248 resumes these in the same Turn, any output but the running
  // status ends the Turn with recovery_partial_turn_aborted.
  ["A4 context_start committed, native user message not: recovery_partial_turn_aborted",
    facts({ events: log(running, contextStart) }),
    partial()],
  ["A6/A7 native tool call committed, its result not: repair it, recovery_partial_turn_aborted",
    facts({ events: log(running, contextStart, assistant([text("running it"), call("call_1")])) }),
    partial([bash("call_1")])],
  ["A8 parallel native tool calls, one result committed: repair only the other",
    facts({ events: log(running, contextStart, assistant([call("call_1"), call("call_2")]), nativeResult("call_2")) }),
    partial([bash("call_1")])],
  ["A9 every native tool result committed: nothing to repair",
    facts({ events: log(running, contextStart, assistant([call("call_1"), call("call_2")]), nativeResult("call_1"), nativeResult("call_2")) }),
    partial()],
  ["A10 final answer committed without a completion marker: recovery_partial_turn_aborted",
    facts({ events: log(running, contextStart, assistant([text("done")])) }),
    partial()],
  ["A11 aborted assistant whose call never got its arguments: the call is answered by its own entry",
    facts({ events: log(running, contextStart, assistant([text("half"), call("call_1")], { stopReason: "aborted" })) }),
    partial()],
  ["A15 MCP tool calls dangling: repaired with the server they name",
    facts({ events: log(running, contextStart,
      assistant([call("call_native", "mcp")], { mcp: { call_native: { name: "search", serverName: "docs" } } }),
      mcpToolUse("call_display", "lookup")) }),
    partial([
      { type: "agent.mcp_tool_use", toolUseId: "call_native", name: "search", serverName: "docs" },
      { type: "agent.mcp_tool_use", toolUseId: "call_display", name: "lookup" },
    ])],
  ["A17 a lost attempt wrote some repairs: repair only the rest",
    facts({ events: log(running, toolUse("call_1"), toolUse("call_2"), toolResult("call_1")) }),
    partial([bash("call_2")])],
  ["a call recorded twice is repaired once",
    facts({ events: log(running, toolUse("call_1"), toolUse("call_1")) }),
    partial([bash("call_1")])],
  ["B2 compaction boundary committed: recovery_partial_turn_aborted",
    facts({ events: log(running, contextStart, ["agent.compaction", { summary: "earlier work" }]) }),
    partial()],
  ["C1/C5 synchronous wait accepted, child still running: resume the wait in its Turn",
    facts({ waits: [wait("call_agent")], events: log(running, contextStart, modelRequest,
      assistant([text("delegating"), call("call_agent", "Agent")], { blockIndex: 0 }), ["session.status_waiting", { turnId: WAITING_TURN }]) }),
    { kind: "run", turnId: WAITING_TURN, resume: { waits: [wait("call_agent")], config: { model: "provider/model", thinking: "low" },
      completedModelSteps: 1, blockBase: 2 } }],
  ["a wait recorded before any output of its Turn: resume it from the first step",
    facts({ waits: [wait("call_agent")], events: log(running) }),
    { kind: "run", turnId: WAITING_TURN, resume: { waits: [wait("call_agent")], config: { model: "provider/model", thinking: "low" },
      completedModelSteps: 0, blockBase: 0 } }],
  ["C2 the wait's result was consumed, the Turn not continued: resume it",
    facts({ waits: [wait("call_agent", "consumed")], events: log(running, contextStart, modelRequest,
      assistant([call("call_agent", "Agent")], { blockIndex: 0 }), delegationResult("call_agent")) }),
    { kind: "run", turnId: WAITING_TURN, resume: { waits: [wait("call_agent", "consumed")], config: { model: "provider/model", thinking: "low" },
      completedModelSteps: 1, blockBase: 1 } }],
  ["a resumed wait whose sibling call has no result: resume the wait, then end with recovery_required",
    facts({ waits: [wait("call_agent")], events: log(running, contextStart, modelRequest,
      assistant([call("call_agent", "Agent"), call("call_bash")], { blockIndex: 0 })) }),
    { kind: "run", turnId: WAITING_TURN, resume: { waits: [wait("call_agent")], config: { model: "provider/model", thinking: "low" },
      completedModelSteps: 1, blockBase: 2, end: { repairs: [bash("call_bash")], error: UNSAFE } } }],
  ["a cancelled wait is not resumed and does not name the Turn",
    facts({ waits: [wait("call_old", "cancelled", "turn_10_a0"), wait("call_agent")], events: log(running) }),
    { kind: "run", turnId: WAITING_TURN, resume: { waits: [wait("call_agent")], config: { model: "provider/model", thinking: "low" },
      completedModelSteps: 0, blockBase: 0 } }],
  ["only cancelled waits: the Turn has nothing to resume",
    facts({ waits: [wait("call_agent", "cancelled")], events: log(running, contextStart, assistant([call("call_agent", "Agent")])) }),
    partial([{ type: "agent.tool_use", toolUseId: "call_agent", name: "Agent" }])],
  ...["session.status_idle", "session.error", "session.turn_aborted"].map((type): [string, ResumeFacts, ResumePlan] => [
    `A12 ${type} committed after a consumed wait: complete the waiting Turn, do not resume it`,
    facts({ waits: [wait("call_agent", "consumed")], events: log(running, contextStart, assistant([call("call_agent", "Agent")]),
      delegationResult("call_agent"), toolUse("call_bash"), [type, { turnId: WAITING_TURN, error: { code: "adapter_error" } }]) }),
    { kind: "complete", cause: "turn_ended", turnId: WAITING_TURN, repairs: [bash("call_bash")], interruptChildren: true }]),
  ["C3 Agent tool call committed, delegation not accepted: no wait, repair the call",
    facts({ events: log(running, contextStart, assistant([call("call_agent", "Agent")])) }),
    partial([{ type: "agent.tool_use", toolUseId: "call_agent", name: "Agent" }])],
];

/** The Child execution of the input, as starting it under the new claim left it. */
const CHILD_TURN = "turn_3_a1";
const lostOwner = { status: "recovery_required", turnId: CHILD_TURN, result: { status: "recovery_required",
  reason: "Execution lease expired; external tool effects may be uncertain. Inspect history and resume explicitly.",
  output: "", trace: { sessionId: "sess", turnId: CHILD_TURN } } } as const;
const executionRows: Array<[string, ResumeFacts, ResumePlan]> = [
  ["C7 the Child execution's lost owner left it running: recovery_required in its Turn, repair its call",
    facts({ execution: lostOwner, events: log(running, toolUse("call_1")) }),
    { kind: "complete", cause: "execution_ended", turnId: CHILD_TURN, repairs: [bash("call_1")], interruptChildren: false,
      error: { phase: "recovery_required", code: "recovery_required", message: lostOwner.result.reason, turnId: CHILD_TURN } }],
  ["C7 a lost owner's execution outranks the partial output it left",
    facts({ execution: lostOwner, events: log(running, contextStart, assistant([text("half done")])) }),
    { kind: "complete", cause: "execution_ended", turnId: CHILD_TURN, repairs: [], interruptChildren: false,
      error: { phase: "recovery_required", code: "recovery_required", message: lostOwner.result.reason, turnId: CHILD_TURN } }],
  ["the Child execution ended before its Turn's completion marker: complete, nothing to add",
    facts({ execution: { status: "completed", turnId: CHILD_TURN }, events: log(running, contextStart, assistant([text("done")])) }),
    { kind: "complete", cause: "execution_ended", turnId: CHILD_TURN, repairs: [], interruptChildren: false }],
  ["a Child execution that ended without running completes this attempt's Turn",
    facts({ execution: { status: "interrupted" } }),
    { kind: "complete", cause: "execution_ended", turnId: NEW_TURN, repairs: [], interruptChildren: false }],
  ["A13 a completed Turn is only acknowledged, whatever its Child execution",
    facts({ execution: { status: "completed", turnId: CHILD_TURN }, events: log(running, completed) }),
    { kind: "acknowledge", turnId: NEW_TURN }],
];

describe("planResume", () => {
  it.each([...rows, ...executionRows])("%s", (_name, given, plan) => {
    expect(planResume(given)).toEqual(plan);
  });

  // The Router learns an execution's state by starting it, once the input is not to be acknowledged.
  it.each(rows)("a Child execution that has not ended changes no plan: %s", (_name, given, plan) => {
    for (const status of ["queued", "running"] as const) {
      expect(planResume({ ...given, execution: { status, turnId: CHILD_TURN } })).toEqual(plan);
    }
  });
});
