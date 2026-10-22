import { describe, expect, it } from "vitest";
import type { StoredEvent } from "@oma-server/store";
import { bash, eventsOfInput, execute, expectResumed, MODELS, OUTCOME_UNKNOWN_PREFIX, PROVIDER, text, usePiSettings,
  type Block, type ModelRequest, type Run, type Scenario } from "./harness.js";

await usePiSettings();

/**
 * Configuration that changes while a Turn's Runner is lost, beyond the edits
 * pinned-config.test.ts covers (#253): the model the Turn is pinned to
 * disappears from its provider, and the Agent and Session are edited while
 * the Turn waits on a synchronous delegation.
 */

const errorsOf = (events: StoredEvent[]) => events.filter((event) => event.type === "session.error")
  .map((event) => (event.data as { error: { code: string; message: string } }).error);

describe("A21 the model a Resumed Turn is pinned to is gone from its provider", () => {
  it("A21 the takeover fails the Turn with an error that names the model, without running another one, and the next Turn runs on the Agent's current model", async () => {
    const MIGRATE = "migrate the database";
    const REPORT = "report the result";
    const scenario: Scenario = {
      inputs: [MIGRATE, REPORT],
      errors: ["pi_agent_error"],
      model: (request) => request.lastUser === REPORT ? { blocks: [text("reported")], stop: "end_turn" }
        : { blocks: [bash("call_migrate", "./migrate.sh")], stop: "tool_use" },
      tool: (_call, run) => { run.crash(); return new Promise<string>(() => {}); },
      // While the Runner is lost, the operator retires the first model and moves the Agent to the second.
      models: (runner) => runner === 0 ? MODELS : [MODELS[1]],
      afterLoss: async (run) => { await run.stores.agentStore.update(run.agentId, { model: `${PROVIDER}/${MODELS[1]}` }); },
    };
    const outcome = await execute(scenario);
    expectResumed(scenario, outcome);
    const turn = eventsOfInput(outcome.log, scenario, 0);
    expect(errorsOf(turn)).toEqual([{ code: "pi_agent_error", message: expect.stringContaining(`${PROVIDER}/${MODELS[0]} is not configured`) }]);
    // The dangling call was answered before the takeover tried to run; no model answered the Turn after the loss.
    expect(JSON.stringify(turn.filter((event) => event.type === "agent.tool_result").map((event) => event.data))).toContain(OUTCOME_UNKNOWN_PREFIX);
    expect(outcome.requests.filter((request) => request.lastUser === MIGRATE).map((request) => [request.runner, request.model])).toEqual([[0, MODELS[0]]]);
    // The next Turn starts with the Agent's model as it is now.
    expect(outcome.requests.filter((request) => request.lastUser === REPORT).map((request) => [request.runner, request.model])).toEqual([[1, MODELS[1]]]);
  });
});

describe("E10 the Agent and Session are edited while the Turn waits on a synchronous delegation and its Runner is lost", () => {
  const PARENT = "summarise the build";
  const NEXT = "report the result";
  const CHILD_TASK = "inspect the build";
  const fromChild = (request: ModelRequest) => !request.text.includes(PARENT) && request.lastUser !== NEXT;
  const agent = (id: string, prompt: string): Block => ({ type: "tool_use", id, name: "Agent", input: { prompt } });
  /** How the scripted Anthropic Messages provider receives each level (pinned-config.test.ts). */
  const THINKING = { high: { type: "enabled", budget_tokens: 7168, display: "summarized" }, minimal: { type: "enabled", budget_tokens: 1024, display: "summarized" } };

  it("E10 the resumed wait and the rest of its Turn keep the original model and thinking; the child keeps its own; the next Turn uses the edit", async () => {
    const scenario: Scenario = {
      inputs: [PARENT, NEXT],
      children: "apart",
      model: (request, run: Run) => {
        if (request.lastUser === NEXT) return { blocks: [text("reported")], stop: "end_turn" };
        if (fromChild(request)) {
          // The parent's Runner is lost while it waits for the child's answer.
          if (request.results.has("call_inspect")) { run.lose("parent"); return { blocks: [text("the build is green")], stop: "end_turn" }; }
          return { blocks: [bash("call_inspect", "make check")], stop: "tool_use" };
        }
        return request.results.has("call_agent") ? { blocks: [text("the child says it is green")], stop: "end_turn" }
          : { blocks: [text("delegating"), agent("call_agent", CHILD_TASK)], stop: "tool_use" };
      },
      afterLoss: async (run) => {
        await run.stores.agentStore.update(run.agentId, { model: `${PROVIDER}/${MODELS[1]}` });
        await run.stores.sessionStore.setThinking(run.sessionId, "minimal");
      },
    };
    const outcome = await execute(scenario);
    expectResumed(scenario, outcome);
    expect(outcome.losses).toEqual([expect.objectContaining({ runner: 0, sessionId: outcome.sessionId, dangling: ["call_agent"] })]);
    const parentRequests = outcome.requests.filter((request) => !fromChild(request) && request.lastUser !== NEXT);
    // The takeover's request carries the child's result and runs as the Turn began.
    expect(parentRequests.map((request) => [request.runner, request.results.has("call_agent")])).toEqual([[0, false], [2, true]]);
    for (const request of parentRequests) expect({ model: request.model, thinking: request.thinking }).toEqual({ model: MODELS[0], thinking: THINKING.high });
    for (const request of outcome.requests.filter(fromChild)) expect(request.model).toBe(MODELS[0]);
    const next = outcome.requests.filter((request) => request.lastUser === NEXT);
    expect(next.map((request) => ({ model: request.model, thinking: request.thinking }))).toEqual([{ model: MODELS[1], thinking: THINKING.minimal }]);
    expect(outcome.executions).toEqual([expect.objectContaining({ status: "completed", notificationStatus: "consumed" })]);
  });
});
