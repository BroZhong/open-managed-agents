import { describe, expect } from "vitest";
import { bash, sweep, text, usePiSettings, OUTCOME_UNKNOWN_PREFIX, type Block, type ModelRequest, type Outcome, type Scenario } from "./harness.js";

await usePiSettings();

/**
 * C13: one assistant message delegates to two children synchronously, so the
 * parent's Turn waits on two Delegation Executions at once. Lost after any of
 * its writes, the parent's takeover resumes every wait it recorded, consumes
 * each child's result once, and creates no child twice.
 */

const PARENT = "inspect the api and the web";
const TASKS: Record<string, string> = { call_api: "inspect the api", call_web: "inspect the web" };
const agent = (id: string, prompt: string): Block => ({ type: "tool_use", id, name: "Agent", input: { prompt } });
const fromChild = (request: ModelRequest) => !request.text.includes(PARENT);
function resultOf(request: ModelRequest, toolUseId: string): Record<string, unknown> {
  const content = JSON.parse(request.results.get(toolUseId)!.text) as string | Array<{ type: string; text: string }>;
  return JSON.parse(typeof content === "string" ? content : content[0].text) as Record<string, unknown>;
}

const scenario: Scenario = {
  inputs: [PARENT],
  children: "apart",
  model: (request) => {
    if (fromChild(request)) {
      const task = Object.values(TASKS).find((candidate) => request.lastUser.includes(candidate))!;
      const id = `bash_${task.split(" ").at(-1)}`;
      return request.results.has(id) ? { blocks: [text(`${task}: green`)], stop: "end_turn" } : { blocks: [bash(id, "make check")], stop: "tool_use" };
    }
    return Object.keys(TASKS).every((id) => request.results.has(id)) ? { blocks: [text("both are green")], stop: "end_turn" }
      : { blocks: [text("delegating"), ...Object.entries(TASKS).map(([id, task]) => agent(id, task))], stop: "tool_use" };
  },
};

/** One execution per call that was accepted before the loss, each completed and consumed once; a call never accepted is of unknown outcome. */
function expectBothDelegated(outcome: Outcome): void {
  // A loss after both results were consumed asks the model once more, with the same results.
  const answered = outcome.requests.filter((request) => !fromChild(request) && Object.keys(TASKS).every((id) => request.results.has(id))).slice(-1);
  expect(answered).toHaveLength(1);
  for (const [id, task] of Object.entries(TASKS)) {
    const executions = outcome.executions.filter((execution) => execution.callerToolUseId === id);
    expect(executions.length, `executions of ${id}`).toBeLessThanOrEqual(1);
    if (!executions.length) {
      expect(answered[0].results.get(id)?.text).toContain(OUTCOME_UNKNOWN_PREFIX);
      continue;
    }
    expect(executions[0]).toMatchObject({ status: "completed", notificationStatus: "consumed", result: { output: `${task}: green` } });
    expect(resultOf(answered[0], id)).toMatchObject({ executionId: executions[0].id, status: "completed", result: { output: `${task}: green` } });
  }
}

describe("C13 crash injection: the parent waits on two synchronous children and is lost after each of its writes", async () => {
  await sweep(scenario, expectBothDelegated);
});
