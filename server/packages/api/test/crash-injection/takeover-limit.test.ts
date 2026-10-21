import { describe, expect, it } from "vitest";
import type { StoredEvent } from "@oma-server/store";
import { bash, eventsOfInput, execute, expectResumed, OUTCOME_UNKNOWN_PREFIX, text, usePiSettings, type Outcome, type Scenario } from "./harness.js";

await usePiSettings();

/**
 * The takeover limit (#250): a Turn whose Runner is lost again and again
 * without the Turn committing progress ends with recovery_limit_exceeded at
 * the fourth such takeover, and the input queued behind it runs. Losses
 * between which the Turn makes progress, and handoffs, do not end it.
 */

const POISON = "render the whole archive";
const NEXT = "say hi";

const errorsOf = (events: StoredEvent[]) => events.filter((event) => event.type === "session.error")
  .map((event) => (event.data as { error: { code: string; message: string } }).error);
const markersOf = (events: StoredEvent[]) => events.filter((event) => event.type === "session.turn_resumed")
  .map((event) => event.data as { generation: number; reason: string });
const answers = (outcome: Outcome, input: number, scenario: Scenario) => eventsOfInput(outcome.log, scenario, input)
  .filter((event) => event.type === "agent.context_entry" && (event.data as { entry?: { message?: { role?: string } } }).entry?.message?.role === "assistant")
  .map((event) => JSON.stringify((event.data as { entry: { message: { content: unknown } } }).entry.message.content));

/** Streaming the archive loses whichever Runner does it, as an answer too large for its memory would. */
const poison: Scenario = {
  inputs: [POISON, NEXT],
  errors: ["recovery_limit_exceeded"],
  model: (request) => request.lastUser === POISON
    ? { blocks: [text("here is the archive")], stop: "end_turn", lostMidStream: true }
    : { blocks: [text("hi")], stop: "end_turn" },
};

/** The poison Turn ended at its fourth takeover, which asked the model nothing; the next input ran after it. */
function expectLimited(scenario: Scenario, outcome: Outcome): void {
  expectResumed(scenario, outcome);
  const turn = eventsOfInput(outcome.log, scenario, 0);
  expect(errorsOf(turn)).toEqual([{ code: "recovery_limit_exceeded", message: expect.stringContaining("lost 4 times") }]);
  // Three takeovers continued it; a later one ended it.
  const markers = markersOf(turn);
  expect(markers.slice(0, 3).map((marker) => marker.generation)).toEqual([2, 3, 4]);
  expect(markers.length).toBeGreaterThanOrEqual(4);
  expect(answers(outcome, 0, scenario)).toEqual([]);
  expect(answers(outcome, 1, scenario)).toEqual([expect.stringContaining("hi")]);
  // No request of the poison Turn after the takeover that ended it.
  const ending = outcome.runners.length - 1;
  expect(outcome.requests.filter((request) => request.lastUser === POISON).every((request) => request.runner < 4)).toBe(true);
  expect(outcome.requests.filter((request) => request.lastUser === NEXT).map((request) => request.runner)).toEqual([ending]);
}

describe("crash injection: the takeover limit", () => {
  it("E1 a poison Turn loses its Runner at the same point every time: the fourth takeover ends it with recovery_limit_exceeded, and the queued input runs", async () => {
    const outcome = await execute(poison);
    expectLimited(poison, outcome);
    // Four Runners were lost to it, each after the previous one took it over.
    expect(outcome.losses.map((loss) => [loss.runner, loss.reason, loss.input])).toEqual([
      [0, "expired", 0], [1, "expired", 0], [2, "expired", 0], [3, "expired", 0]]);
    expect(markersOf(outcome.log)).toEqual([2, 3, 4, 5].map((generation) => expect.objectContaining({ generation, reason: "expired" })));
    // Every lost attempt was continued from the committed input, never prompted again.
    expect(outcome.requests.filter((request) => request.lastUser === POISON).map((request) => request.runner)).toEqual([0, 1, 2, 3]);
  });

  describe("E1/A17 the takeover that ends the Turn is lost after each of its writes: the Turn is ended once", async () => {
    const baseline = await execute(poison);
    const ending = baseline.runners[4].writes;
    const acknowledged = ending.findIndex((write) => write.method === "ackCompletedTurn") + 1;
    it.each(ending.slice(0, acknowledged).map((write, index) => [index + 1, write.method === "append"
      ? `append ${(write.result as StoredEvent).type}` : write.method] as const))("lost after its write %i (%s)", async (n) => {
      expectLimited(poison, await execute(poison, [undefined, undefined, undefined, undefined, n]));
    });
  });

  it("E2 progress between takeovers resets the count: six losses, never four in a row without progress, and the Turn completes", async () => {
    // Requests 0-2 and 4-5 lose their Runner while they stream; request 3
    // commits a tool call whose run loses its Runner; request 6 answers.
    const scenario: Scenario = {
      inputs: ["migrate every table"],
      model: (request) => request.index === 3 ? { blocks: [bash("call_migrate", "./migrate.sh")], stop: "tool_use" }
        : request.index === 6 ? { blocks: [text("migrated")], stop: "end_turn" }
        : { blocks: [text("migrating")], stop: "end_turn", lostMidStream: true },
      tool: (_call, run) => { run.crash(); return new Promise<string>(() => {}); },
    };
    const outcome = await execute(scenario);
    expectResumed(scenario, outcome);
    expect(markersOf(outcome.log).map((marker) => marker.reason)).toEqual(Array(6).fill("expired"));
    expect(outcome.requests.map((request) => request.runner)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(answers(outcome, 0, scenario).at(-1)).toContain("migrated");
  });

  it("E2 a long Turn that commits progress before each loss survives many losses", async () => {
    // Each step's tool run loses its Runner; the takeover reports the step's
    // outcome as unknown, and the Agent goes on to the next one.
    const steps = 7;
    const scenario: Scenario = {
      inputs: ["run every step"],
      model: (request) => request.results.size < steps
        ? { blocks: [bash(`call_step_${request.results.size}`, `./step.sh ${request.results.size}`)], stop: "tool_use" }
        : { blocks: [text("every step ran")], stop: "end_turn" },
      tool: (_call, run) => { run.crash(); return new Promise<string>(() => {}); },
    };
    const outcome = await execute(scenario);
    expectResumed(scenario, outcome);
    expect(outcome.losses).toHaveLength(steps);
    expect(outcome.requests.at(-1)?.results.size).toBe(steps);
    expect([...outcome.requests.at(-1)!.results.values()].every((result) => result.isError && result.text.includes(OUTCOME_UNKNOWN_PREFIX))).toBe(true);
  });

  it("E3 handoffs are not counted: three losses, then two handoffs without progress, and the Turn completes", async () => {
    // Requests 0-2 lose their Runner; requests 3-4 find their Runner shutting
    // down, which hands the Turn over; request 5 answers.
    const scenario: Scenario = {
      inputs: [POISON],
      model: (request, run) => {
        if (request.index < 3) return { blocks: [text("here is the archive")], stop: "end_turn", lostMidStream: true };
        if (request.index < 5) run.handOff();
        return { blocks: [text("the archive")], stop: "end_turn" };
      },
    };
    const outcome = await execute(scenario);
    expectResumed(scenario, outcome);
    expect(markersOf(outcome.log).map((marker) => marker.reason)).toEqual(["expired", "expired", "expired", "released", "released"]);
    expect(answers(outcome, 0, scenario)).toEqual([expect.stringContaining("the archive")]);
  });

  it("E3/F7 a handoff neither counts nor resets the count: the loss after it is the fourth, and ends the Turn", async () => {
    // Requests 0-2 lose their Runner, request 3 is handed over, request 4 loses its Runner again.
    const scenario: Scenario = {
      ...poison,
      model: (request, run) => {
        if (request.lastUser !== POISON) return { blocks: [text("hi")], stop: "end_turn" };
        if (request.index === 3) run.handOff();
        return { blocks: [text("here is the archive")], stop: "end_turn", lostMidStream: true };
      },
    };
    const outcome = await execute(scenario);
    expectResumed(scenario, outcome);
    const turn = eventsOfInput(outcome.log, scenario, 0);
    expect(markersOf(turn).map((marker) => marker.reason)).toEqual(["expired", "expired", "expired", "released", "expired"]);
    expect(errorsOf(turn).map((error) => error.code)).toEqual(["recovery_limit_exceeded"]);
    expect(answers(outcome, 1, scenario)).toEqual([expect.stringContaining("hi")]);
  });

  it("E4 a Runner stopped by a failed write counts as lost: an answer the event log refuses every time ends the Turn at the fourth takeover", async () => {
    // PostgreSQL stores no NUL character in JSON, so the answer is never committed.
    const scenario: Scenario = {
      ...poison,
      model: (request) => ({ blocks: [text(request.lastUser === POISON ? "here is the archive\u0000" : "hi")], stop: "end_turn" }),
      refuse: (event) => JSON.stringify(event.data).includes("\\u0000"),
    };
    const outcome = await execute(scenario);
    expectLimited(scenario, outcome);
    // No Runner was lost: each stopped its attempt and let its claim lapse.
    expect(outcome.runners.every((runner, index) => index === 4 || outcome.errors.some((error) => error.runner === index))).toBe(true);
    expect(outcome.losses.map((loss) => loss.reason)).toEqual(["expired", "expired", "expired", "expired"]);
  });
});
