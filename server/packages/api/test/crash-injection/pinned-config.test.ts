import { describe, expect, it } from "vitest";
import type { StoredEvent } from "@oma-server/store";
import { bash, eventsOfInput, execute, expectResumed, MODELS, PROVIDER, sweep, text, usePiSettings, type Outcome, type Run, type Scenario } from "./harness.js";

await usePiSettings();

/**
 * A Resumed Turn keeps the model and thinking its first attempt ran with
 * (#253): the Agent's model or the Session's thinking edited while the Turn
 * runs changes only later Turns. Its system prompt, Skills and MCP servers are
 * assembled from the configuration current when an attempt starts.
 */

interface TurnConfig { model: string; thinking: string }
/** The Agent starts on the first model, and the model's default thinking applies. */
const ORIGINAL: TurnConfig = { model: MODELS[0], thinking: "high" };
/** What the user changes it to mid-Turn: another model, and the Session's thinking. */
const EDITED: TurnConfig = { model: MODELS[1], thinking: "minimal" };
/** How the scripted Anthropic Messages provider receives each level: Pi's own serialization. */
const THINKING_PARAMETER: Record<string, unknown> = {
  high: { type: "enabled", budget_tokens: 7168, display: "summarized" },
  minimal: { type: "enabled", budget_tokens: 1024, display: "summarized" },
};

const editConfiguration = async (run: Run) => {
  await run.stores.agentStore.update(run.agentId, { model: `${PROVIDER}/${EDITED.model}` });
  await run.stores.sessionStore.setThinking(run.sessionId, "minimal");
};

const contextStarts = (events: StoredEvent[]) => events.filter((event) => event.type === "agent.context_start")
  .map((event) => event.data as { model: string; thinking: string });
/** The model requests answering an input, by the text of its user message. */
const requestsOf = (outcome: Outcome, scenario: Scenario, input: number) =>
  outcome.requests.filter((request) => !request.summary && request.lastUser === scenario.inputs[input]);

/** Every request of the input, and every claim of it, used `expected`. */
function expectTurnConfig(outcome: Outcome, scenario: Scenario, input: number, expected: TurnConfig) {
  const requests = requestsOf(outcome, scenario, input);
  expect(requests.length, `requests of input ${input}`).toBeGreaterThan(0);
  for (const request of requests) {
    expect({ model: request.model, thinking: request.thinking }, `request ${request.index} (runner ${request.runner})`)
      .toEqual({ model: expected.model, thinking: THINKING_PARAMETER[expected.thinking] });
  }
  const starts = contextStarts(eventsOfInput(outcome.log, scenario, input));
  expect(starts.length).toBeGreaterThan(0);
  for (const start of starts) expect(start).toEqual(expect.objectContaining({ model: `${PROVIDER}/${expected.model}`, thinking: expected.thinking }));
}

describe("crash injection: a Resumed Turn's model and thinking", () => {
  it("E5 the Agent's model and the Session's thinking edited mid-Turn, then the Runner is lost: the takeover keeps the original ones, the next Turn uses the new ones", async () => {
    const scenario: Scenario = {
      inputs: ["migrate the database", "report the result"],
      model: async (request, run) => {
        if (request.lastUser === "report the result") return { blocks: [text("reported")], stop: "end_turn" };
        if (request.results.has("call_migrate")) return { blocks: [text("checked the migration state")], stop: "end_turn" };
        // The user edits the configuration while the Turn's first request is answered.
        await editConfiguration(run);
        return { blocks: [bash("call_migrate", "./migrate.sh")], stop: "tool_use" };
      },
      // The Runner is lost while the migration runs.
      tool: (_call, run) => { run.crash(); return new Promise<string>(() => {}); },
    };
    const outcome = await execute(scenario);
    expectResumed(scenario, outcome);
    expect(outcome.losses).toEqual([expect.objectContaining({ runner: 0, input: 0, dangling: ["call_migrate"] })]);
    // The takeover continued the Turn on the model and thinking it started with.
    expect(requestsOf(outcome, scenario, 0).map((request) => request.runner)).toEqual([0, 1]);
    expectTurnConfig(outcome, scenario, 0, ORIGINAL);
    const takeover = outcome.attempts.find((attempt) => attempt.runner === 1 && attempt.input.resume)!;
    expect(takeover.input).toMatchObject({ agent: { model: `${PROVIDER}/${ORIGINAL.model}` }, execution: { thinking: ORIGINAL.thinking } });
    // The edit applies from the next Turn.
    expectTurnConfig(outcome, scenario, 1, EDITED);
  });

  it("E6 the system prompt and Skills edited mid-Turn, then the Runner is lost: the takeover assembles the current ones", async () => {
    const scenario: Scenario = {
      inputs: ["migrate the database"],
      model: async (request, run) => {
        if (request.results.has("call_migrate")) return { blocks: [text("checked the migration state")], stop: "end_turn" };
        const skill = await run.stores.skillStore.create({ tenantId: "tenant", name: "db-runbook", description: "How this team migrates databases",
          ownerType: "agent", ownerId: run.agentId });
        await run.stores.skillArtifactStore.put("tenant", skill.id, "SKILL.md", "# Runbook");
        await run.stores.agentStore.update(run.agentId, { system: "Follow the edited runbook.", skills: [skill.id] });
        await editConfiguration(run);
        return { blocks: [bash("call_migrate", "./migrate.sh")], stop: "tool_use" };
      },
      tool: (_call, run) => { run.crash(); return new Promise<string>(() => {}); },
    };
    const outcome = await execute(scenario);
    expectResumed(scenario, outcome);
    const [lost, resumed] = requestsOf(outcome, scenario, 0);
    expect(lost.system).not.toContain("Follow the edited runbook.");
    expect(lost.system).not.toContain("db-runbook");
    expect([resumed.runner, resumed.results.has("call_migrate")]).toEqual([1, true]);
    expect(resumed.system).toContain("Follow the edited runbook.");
    expect(resumed.system).toContain("db-runbook");
    expect(resumed.system).toContain("How this team migrates databases");
    // Only the model and thinking stay as the Turn started.
    expectTurnConfig(outcome, scenario, 0, ORIGINAL);
  });
});

/**
 * E5 at every crash point: the configuration is edited while no Runner runs
 * the Session. A Turn whose first attempt claimed its input before the loss
 * keeps that attempt's configuration on every attempt, prompted again or
 * continued; a Turn that no attempt claimed yet starts with the edited one.
 */
const scenario: Scenario = {
  inputs: ["clean the workspace", "report the result"],
  model: (request) => request.lastUser === "report the result" ? { blocks: [text("reported")], stop: "end_turn" }
    : request.results.has("call_bash") ? { blocks: [text("cleaned")], stop: "end_turn" }
    : { blocks: [text("cleaning"), bash("call_bash", "rm -rf build")], stop: "tool_use" },
  afterLoss: editConfiguration,
};

describe("crash injection: E5 the Agent's model and the Session's thinking edited while the Runner is lost", async () => {
  await sweep(scenario, (outcome) => {
    const lost = outcome.runners[0];
    const writtenBefore = new Set(lost.writes.flatMap((write) => write.method === "append" ? [(write.result as StoredEvent).seq] : []));
    scenario.inputs.forEach((_text, input) => {
      const [claim] = eventsOfInput(outcome.log, scenario, input).filter((event) => event.type === "agent.context_start");
      expectTurnConfig(outcome, scenario, input, writtenBefore.has(claim.seq) ? ORIGINAL : EDITED);
    });
  });
});
