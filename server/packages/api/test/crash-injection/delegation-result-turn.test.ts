import { describe, expect } from "vitest";
import { sweep, text, usePiSettings, type Block, type ModelRequest, type Outcome, type Scenario } from "./harness.js";

await usePiSettings();

/**
 * C14: a background child finishes after its parent's Turn ended, so its
 * Delegation Result arrives as an input of its own and starts a parent Turn
 * that reports it. Lost after any write, before, during or after that Turn,
 * the result is delivered once and answered once, and no child runs twice.
 */

const PARENT = "triage the issues in the background";
const CHILD_TASK = "list the open issues";
const CHILD_ANSWER = "3 open issues";
const REPORT = "the child found 3 open issues";
const fromChild = (request: ModelRequest) => request.lastUser.includes(CHILD_TASK) && !request.text.includes(PARENT);
const call = (id: string, name: string, input: Record<string, unknown>): Block => ({ type: "tool_use", id, name, input });

const scenario: Scenario = {
  inputs: [PARENT],
  model: (request) => {
    if (fromChild(request)) return { blocks: [text(CHILD_ANSWER)], stop: "end_turn" };
    // The Delegation Result's Turn: its input carries the child's outcome.
    if (request.lastUser.includes(CHILD_ANSWER)) return { blocks: [text(REPORT)], stop: "end_turn" };
    if (request.results.has("call_agent")) return { blocks: [text("delegated; the result follows")], stop: "end_turn" };
    return { blocks: [call("call_agent", "Agent", { prompt: CHILD_TASK, run_in_background: true })], stop: "tool_use" };
  },
};

const answers = (outcome: Outcome) => outcome.log.filter((event) => event.type === "agent.context_entry" &&
  (event.data as { entry?: { message?: { role?: string } } }).entry?.message?.role === "assistant")
  .map((event) => JSON.stringify((event.data as { entry: { message: { content: unknown } } }).entry.message.content));

describe("C14 crash injection: a background child's result starts a parent Turn of its own; the Runner is lost after each write", async () => {
  await sweep(scenario, (outcome) => {
    // A loss before the delegation was accepted left no child (C3), so no result arrives.
    if (!outcome.executions.length) return;
    expect(outcome.executions).toEqual([expect.objectContaining({ callerToolUseId: "call_agent", status: "completed", notificationStatus: "processed",
      result: expect.objectContaining({ output: CHILD_ANSWER }) })]);
    expect(outcome.sessions[0].inputs).toEqual([PARENT, `subagent.result:${outcome.executions[0].id}`]);
    expect(outcome.log.filter((event) => event.type === "subagent.result_claimed")).toHaveLength(1);
    expect(answers(outcome).filter((answer) => answer.includes(REPORT))).toHaveLength(1);
  });
});
