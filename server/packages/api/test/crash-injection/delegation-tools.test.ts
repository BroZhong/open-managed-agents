import { describe, expect, it } from "vitest";
import type { DelegationCommand, DelegationExecution, DelegationWait, StoredEvent } from "@oma-server/store";
import { execute, expectResumed, OUTCOME_UNKNOWN_PREFIX, text, usePiSettings, type Block, type ModelRequest, type Outcome, type Scenario, type Write } from "./harness.js";

await usePiSettings();

/**
 * C3–C6 (#251): a delegation tool call a lost Runner left without a result is
 * answered from the delegation record the call left, as the tool would have
 * answered it, instead of as of unknown outcome. Told the outcome is unknown,
 * the Agent would delegate again under a new call id, which the (calling Turn,
 * tool use) idempotency key cannot recognise: a second child. A call that left
 * no record is still of unknown outcome.
 */

const CHILD_TASK = "list the open issues";
const CHILD_ANSWER = "3 open issues";
const STEERING = "also list the closed ones";

const call = (id: string, name: string, input: Record<string, unknown>): Block => ({ type: "tool_use", id, name, input });
/** The value a delegation tool's result carries, as the model received it. */
function resultOf(request: ModelRequest, toolUseId: string): Record<string, unknown> {
  const content = JSON.parse(request.results.get(toolUseId)!.text) as string | Array<{ type: string; text: string }>;
  return JSON.parse(typeof content === "string" ? content : content[0].text) as Record<string, unknown>;
}
const unknown = (request: ModelRequest, toolUseId: string) => request.results.get(toolUseId)?.text.includes(OUTCOME_UNKNOWN_PREFIX) ?? false;
/** The child's own model: it answers its task at once. */
const child = (request: ModelRequest) => request.lastUser.includes(CHILD_TASK);
const answer = (value: string) => ({ blocks: [text(value)], stop: "end_turn" as const });
const use = (block: Block) => ({ blocks: [block], stop: "tool_use" as const });

/** Lose the Runner right after Pi committed the assistant message requesting `toolUseId`, before the tool ran. */
const requested = (toolUseId: string) => (write: Write) => {
  if (write.method !== "append") return false;
  const message = ((write.result as StoredEvent).data as { entry?: { message?: { role?: string; content?: Array<{ type: string; id?: string }> } } }).entry?.message;
  return message?.role === "assistant" && (message.content ?? []).some((block) => block.type === "toolCall" && block.id === toolUseId);
};
/** Lose the Runner right after the delegation store committed a record of `toolUseId`. */
const recorded = (method: "accept" | "saveWait" | "command", toolUseId: string) => (write: Write) =>
  write.method === method && (write.result as DelegationExecution | DelegationWait | DelegationCommand).callerToolUseId === toolUseId;

const executionsOf = (outcome: Outcome) => outcome.stores.delegationStore.list("tenant", outcome.sessionId);
const childrenOf = async (outcome: Outcome) => (await outcome.stores.sessionStore.list("tenant")).data
  .filter((session) => session.delegation?.parentSessionId === outcome.sessionId);
/** The first request of the Runner that took over, which carries what it answered for the dangling call. */
const resumedWith = (outcome: Outcome, toolUseId: string, runner = 1) =>
  outcome.requests.find((request) => request.runner === runner && !child(request) && request.results.has(toolUseId))!;
/**
 * Who wrote a call's result: the takeover's repair (a record's resolver, or
 * outcome unknown), a resumed wait, or the tool itself.
 */
function answeredBy(outcome: Outcome, toolUseId: string): "repair" | "wait" | "tool" {
  const row = outcome.log.find((event) => event.type === "agent.tool_result" && (event.data as { toolUseId?: string }).toolUseId === toolUseId);
  const id = (row?.data as { id?: string } | undefined)?.id ?? "";
  return id.startsWith("recovery_") ? "repair" : id.startsWith("delegation_result_") ? "wait" : "tool";
}

/**
 * The parent delegates in the background, then collects the child's result
 * with a waiting get_subagent_result, which consumes it in the same Turn.
 */
const background: Scenario = {
  inputs: ["triage the issues in the background"],
  model: (request) => {
    if (child(request)) return answer(CHILD_ANSWER);
    if (request.results.has("call_collect")) return answer("the child found 3 open issues");
    if (unknown(request, "call_agent")) return answer("the delegation may not have started; checking before delegating again");
    if (request.results.has("call_agent")) {
      const { childId, executionId } = resultOf(request, "call_agent");
      return use(call("call_collect", "get_subagent_result", { childId, executionId, wait: true }));
    }
    return use(call("call_agent", "Agent", { prompt: CHILD_TASK, run_in_background: true }));
  },
};

describe("crash injection: dangling Agent calls (#251)", () => {
  it("C4 background Agent accepted, Runner lost before its result was committed: the takeover answers with the created child, no second child", async () => {
    const outcome = await execute(background, [recorded("accept", "call_agent")]);
    expectResumed(background, outcome, { recorded: ["call_agent"] });
    expect(outcome.losses).toEqual([expect.objectContaining({ dangling: ["call_agent"] })]);
    const executions = await executionsOf(outcome);
    expect(executions).toHaveLength(1);
    expect(await childrenOf(outcome)).toHaveLength(1);
    const [execution] = executions;
    // The resumed model gets the call's result as Agent returns it: the Child Session and its execution.
    const resumed = resumedWith(outcome, "call_agent");
    expect(resumed.results.get("call_agent")?.isError).toBe(false);
    expect(resultOf(resumed, "call_agent")).toMatchObject({ childId: execution.childId, executionId: execution.id,
      mode: "async", runInBackground: true, trace: { sessionId: execution.childId } });
    // It collects that child's result instead of delegating again.
    expect(execution).toMatchObject({ callerToolUseId: "call_agent", status: "completed", notificationStatus: "consumed" });
    expect(resultOf(outcome.requests.at(-1)!, "call_collect")).toMatchObject({ executionId: execution.id, status: "completed",
      result: { output: CHILD_ANSWER } });
    expect(answeredBy(outcome, "call_agent")).toBe("repair");
  });

  it.each([
    ["before it answered the call", (write: Write) => write.method === "append" && (write.result as StoredEvent).type === "session.turn_resumed"],
    ["right after it answered the call", (write: Write) => write.method === "append" && (write.result as StoredEvent).type === "agent.tool_result" &&
      ((write.result as StoredEvent).data as { toolUseId?: string }).toolUseId === "call_agent"],
  ])("C4/A17 the takeover is lost too, %s: the call is answered once from its record, no second child", async (_when, lostAt) => {
    const outcome = await execute(background, [recorded("accept", "call_agent"), lostAt]);
    expectResumed(background, outcome, { recorded: ["call_agent"] });
    // Each Runner was lost holding the parent's claim; the second may have held the child's too.
    expect(outcome.losses.filter((loss) => loss.sessionId === outcome.sessionId)).toHaveLength(2);
    const [execution, ...others] = await executionsOf(outcome);
    expect(others).toEqual([]);
    // A child its lost owner left running is resumed, not ended (#252).
    expect(execution.status).toBe("completed");
    expect(await childrenOf(outcome)).toHaveLength(1);
    const answeredAt = outcome.requests.find((request) => !child(request) && request.results.has("call_agent"))!;
    expect(resultOf(answeredAt, "call_agent")).toMatchObject({ childId: execution.childId, executionId: execution.id });
    expect(answeredBy(outcome, "call_agent")).toBe("repair");
  });

  it("C3 Agent call committed, Runner lost before the delegation was accepted: no record, so the outcome is unknown and no child exists", async () => {
    const outcome = await execute(background, [requested("call_agent")]);
    expectResumed(background, outcome);
    expect(unknown(resumedWith(outcome, "call_agent"), "call_agent")).toBe(true);
    expect(answeredBy(outcome, "call_agent")).toBe("repair");
    expect(await executionsOf(outcome)).toEqual([]);
    expect(await childrenOf(outcome)).toEqual([]);
  });

  it("C4 synchronous Agent accepted, Runner lost before its result was committed: its wait answers it, once, with the child's result", async () => {
    const synchronous: Scenario = {
      inputs: ["triage the issues"],
      model: (request) => child(request) ? answer(CHILD_ANSWER)
        : request.results.has("call_agent") ? answer("the child found 3 open issues")
        : use(call("call_agent", "Agent", { prompt: CHILD_TASK })),
    };
    const outcome = await execute(synchronous, [recorded("accept", "call_agent")]);
    // One result for the call (no resolver answer beside the wait's): expectResumed counts them.
    expectResumed(synchronous, outcome, { recorded: ["call_agent"] });
    const [execution, ...others] = await executionsOf(outcome);
    expect(others).toEqual([]);
    expect(resultOf(resumedWith(outcome, "call_agent"), "call_agent")).toMatchObject({ childId: execution.childId,
      executionId: execution.id, mode: "sync", status: "completed", result: { output: CHILD_ANSWER } });
    expect(answeredBy(outcome, "call_agent")).toBe("wait");
  });
});

/**
 * The parent delegates synchronously, so the child has ended before it reads
 * the child's state (get_subagent_result) and steers it (steer_subagent).
 */
const followUp = (wait: boolean): Scenario => ({
  inputs: ["triage the issues, then follow up"],
  model: (request) => {
    if (child(request)) return answer(CHILD_ANSWER);
    if (request.results.has("call_steer")) return answer("followed up");
    const ids = () => { const { childId, executionId } = resultOf(request, "call_agent"); return { childId, executionId }; };
    if (request.results.has("call_peek")) return use(call("call_steer", "steer_subagent", { ...ids(), message: STEERING }));
    if (request.results.has("call_agent")) return use(call("call_peek", "get_subagent_result", { ...ids(), wait }));
    return use(call("call_agent", "Agent", { prompt: CHILD_TASK }));
  },
});

describe("crash injection: dangling get_subagent_result and steer_subagent calls (#251)", () => {
  it.each([false, true])("C5 get_subagent_result(wait=%s) committed, Runner lost before it recorded anything: the takeover answers with the execution's current state", async (wait) => {
    const scenario = followUp(wait);
    const outcome = await execute(scenario, [requested("call_peek")]);
    expectResumed(scenario, outcome, { recorded: ["call_peek"] });
    const [execution] = await executionsOf(outcome);
    const resumed = resumedWith(outcome, "call_peek");
    expect(resumed.results.get("call_peek")?.isError).toBe(false);
    expect(resultOf(resumed, "call_peek")).toMatchObject({ childId: execution.childId, executionId: execution.id,
      status: "completed", result: { output: CHILD_ANSWER } });
    expect(answeredBy(outcome, "call_peek")).toBe("repair");
  });

  it.each([false, true])("C5 get_subagent_result(wait=%s) lost after it recorded its wait: the resumed wait answers it, once", async (wait) => {
    const scenario = followUp(wait);
    const outcome = await execute(scenario, [recorded("saveWait", "call_peek")]);
    expectResumed(scenario, outcome, { recorded: ["call_peek"] });
    const [execution] = await executionsOf(outcome);
    expect(resultOf(resumedWith(outcome, "call_peek"), "call_peek")).toMatchObject({ executionId: execution.id,
      status: "completed", result: { output: CHILD_ANSWER } });
    expect(answeredBy(outcome, "call_peek")).toBe("wait");
  });

  it("C6 steer_subagent accepted, Runner lost before its result was committed: the takeover answers with the accepted command's status", async () => {
    const scenario = followUp(false);
    const outcome = await execute(scenario, [recorded("command", "call_steer")]);
    expectResumed(scenario, outcome, { recorded: ["call_steer"] });
    const [execution] = await executionsOf(outcome);
    const [command, ...others] = await outcome.stores.delegationStore.listCommands(execution.id);
    expect(others).toEqual([]);
    const resumed = resumedWith(outcome, "call_steer");
    expect(resumed.results.get("call_steer")?.isError).toBe(false);
    // The child had ended, so the command was recorded as never to be applied.
    expect(resultOf(resumed, "call_steer")).toMatchObject({ id: command.id, kind: "steer", message: STEERING,
      executionId: execution.id, status: "not_applied" });
    expect(answeredBy(outcome, "call_steer")).toBe("repair");
  });

  it("C6 steer_subagent committed, Runner lost before the command was accepted: no record, so the outcome is unknown", async () => {
    const scenario = followUp(false);
    const outcome = await execute(scenario, [requested("call_steer")]);
    expectResumed(scenario, outcome);
    expect(unknown(resumedWith(outcome, "call_steer"), "call_steer")).toBe(true);
    const [execution] = await executionsOf(outcome);
    expect(await outcome.stores.delegationStore.listCommands(execution.id)).toEqual([]);
  });
});
