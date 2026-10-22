import { describe, expect, it } from "vitest";
import { presentEvent, type StoredEvent } from "@oma-server/store";
import { bash, describeWrite, eventsOfInput, execute, expectResumed, INTERRUPTED_PREFIX, OUTCOME_UNKNOWN_PREFIX, rowOf, sweep, text, usePiSettings,
  writesOf, type Outcome, type Scenario } from "./harness.js";

await usePiSettings();

/**
 * D1 at every crash point (#249): the user stops the Turn, the API accepts
 * the Interrupt under the Runner's live claim, and the Runner is lost before
 * it sees it. Whatever the lost attempt committed, the takeover ends the Turn
 * as an Interrupted Turn without asking the model anything, unless the Turn
 * had completed already, and the input queued behind it runs.
 */

const FIRST = "clean the workspace";
const NEXT = "then report";

/** One bash call, its result and the final answer; then a queued input answered at once. */
const scenario: Scenario = {
  inputs: [FIRST, NEXT],
  interruptOnLoss: true,
  model: (request) => request.lastUser === NEXT ? { blocks: [text("reported")], stop: "end_turn" }
    : request.results.has("call_bash") ? { blocks: [text("cleaned")], stop: "end_turn" }
    : { blocks: [text("cleaning"), bash("call_bash", "rm -rf build")], stop: "tool_use" },
};

const typesOf = (events: StoredEvent[], type: string) => events.filter((event) => event.type === type);
/** The results of a call as a console shows them: the Router's repairs and Pi's native results alike. */
const resultText = (events: StoredEvent[], toolUseId: string) => JSON.stringify(events.flatMap((event) => presentEvent(event)).filter((event) =>
  event.type === "agent.tool_result" && (event.data as { toolUseId?: string }).toolUseId === toolUseId).map((event) => event.data));

/**
 * The input the lost Runner held ended as an Interrupted Turn, unless it had
 * completed: no model request and no Adapter run for it after the loss, every
 * call it left dangling answered as interrupted. Every other input ran as usual.
 */
function expectInterruptedAtLoss(outcome: Outcome): void {
  const [loss] = outcome.losses;
  scenario.inputs.forEach((input, index) => {
    const events = eventsOfInput(outcome.log, scenario, index);
    const stopped = loss.input === index && !loss.completed;
    expect(typesOf(events, "session.turn_aborted"), `turn_aborted of input ${index}`).toHaveLength(stopped ? 1 : 0);
    if (!stopped) return;
    expect(outcome.requests.filter((request) => request.runner > 0 && request.lastUser === input)).toEqual([]);
    expect(outcome.attempts.filter((attempt) => attempt.runner > 0 && attempt.input.message.content.some((block) => block.type === "text" && block.text === input))).toEqual([]);
    for (const call of loss.dangling) {
      expect(resultText(events, call)).toContain(INTERRUPTED_PREFIX);
      expect(resultText(events, call)).not.toContain(OUTCOME_UNKNOWN_PREFIX);
    }
    // The takeover marked itself before it ended the Turn.
    const types = events.map((event) => event.type);
    expect(types.indexOf("session.turn_resumed")).toBeLessThan(types.indexOf("session.turn_aborted"));
  });
  // The input queued behind an interrupted one was answered by the model.
  if (loss.input === 0 && !loss.completed) {
    expect(outcome.requests.filter((request) => request.lastUser === NEXT)).not.toEqual([]);
    expect(JSON.stringify(eventsOfInput(outcome.log, scenario, 1).map((event) => event.data))).toContain("reported");
  }
}

describe("D1 crash injection: an Interrupt accepted right before the Runner is lost, at every crash point", async () => {
  await sweep(scenario, expectInterruptedAtLoss);
});

describe("D6 crash injection: the takeover that applies the Interrupt is lost too, after each of its writes", async () => {
  const writes = await writesOf(scenario);
  // The first Runner is lost before its input's Turn named itself, with its
  // call dangling, or with its call answered.
  const at = (label: string) => writes.findIndex((write) => describeWrite(write) === label) + 1;
  const assistant = writes.findIndex((write, index) => describeWrite(write) === "append agent.context_entry(assistant)" && rowOf(writes, index) === "A6") + 1;
  for (const lostAt of [at("claim"), assistant, assistant + 1]) {
    const takeover = (await execute(scenario, [lostAt])).runners[1].writes;
    // Up to the takeover's acknowledgement: what it writes after that is the next input's.
    const acknowledged = takeover.findIndex((write) => write.method === "ackCompletedTurn") + 1;
    it.each(takeover.slice(0, acknowledged).map((write, index) => [lostAt, index + 1, describeWrite(write)] as const))(
      "Runner 0 lost after write %i, the takeover after its write %i (%s): the Interrupted Turn is ended once",
      async (_lostAt, n) => {
        const outcome = await execute(scenario, [lostAt, n]);
        expectResumed(scenario, outcome);
        const first = eventsOfInput(outcome.log, scenario, 0);
        expect(typesOf(first, "session.turn_aborted")).toHaveLength(1);
        expect(typesOf(first, "session.turn_completed")).toHaveLength(1);
        expect(outcome.requests.filter((request) => request.runner > 0 && request.lastUser === FIRST)).toEqual([]);
        for (const call of outcome.losses[0].dangling) expect(resultText(first, call)).toContain(INTERRUPTED_PREFIX);
      });
  }
});

/**
 * D7: the user stops the Turn after the lost Runner's lease ran out but
 * before a Runner took the input over: the Turn still runs as far as the user
 * can tell, so the Interrupt is accepted and the takeover applies it.
 */
describe("D7 crash injection: an Interrupt requested after the lost Runner's lease ran out, before the takeover, at every crash point", async () => {
  const requested: boolean[] = [];
  const afterExpiry: Scenario = { ...scenario, interruptOnLoss: false, afterLoss: async (run) => { requested.push(await run.requestInterrupt()); } };
  await sweep(afterExpiry, (outcome) => {
    const [loss] = outcome.losses;
    // Nothing executes once the input the Runner held was acknowledged; a Turn that started is stopped.
    if (loss.input !== undefined && !loss.completed) expect(requested.at(-1)).toBe(true);
    if (loss.input === undefined) expect(requested.at(-1)).toBe(false);
    expectInterruptedAtLoss(outcome);
  });
});

describe("an Interrupt around a takeover or a handoff", () => {
  it("D8 the user stops the Turn while the takeover prepares it: the resumed attempt asks the model nothing and the Turn ends interrupted", async () => {
    const lostMidTool: Scenario = { ...scenario, interruptOnLoss: false,
      tool: (call, run) => { if (run.runner > 0) return `ran ${call.id}`; run.crash(); return new Promise<string>(() => {}); },
      // The Interrupt and its hint arrive as the takeover writes its marker.
      refuse: (event, run) => {
        if (run.runner === 1 && event.type === "session.turn_resumed") void run.interrupt(run.sessionId);
        return false;
      } };
    const outcome = await execute(lostMidTool);
    expectResumed(lostMidTool, outcome);
    const first = eventsOfInput(outcome.log, lostMidTool, 0);
    expect(typesOf(first, "session.turn_aborted")).toHaveLength(1);
    expect(outcome.requests.filter((request) => request.runner > 0 && request.lastUser === FIRST)).toEqual([]);
    // The takeover had already answered the call it found dangling; nothing ran it again.
    expect(resultText(first, "call_bash")).toContain(OUTCOME_UNKNOWN_PREFIX);
    expect(outcome.toolCalls.map((call) => call.runner)).toEqual([0]);
    expect(outcome.requests.filter((request) => request.lastUser === NEXT).map((request) => request.runner)).toEqual([1]);
  });

  it("D9 an Interrupt accepted while the Turn is handed over, before its owner applied it: the next Runner ends it as an Interrupted Turn without asking the model", async () => {
    const handedOver: Scenario = { ...scenario, interruptOnLoss: false,
      tool: async (call, run) => {
        if (run.runner === 0) {
          // The user stops the Turn as the rollout restarts its Runner; the hint is lost.
          expect(await run.requestInterrupt()).toBe(true);
          run.shutDown();
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return `ran ${call.id}`;
      } };
    const outcome = await execute(handedOver);
    expectResumed(handedOver, outcome);
    expect(outcome.losses).toEqual([expect.objectContaining({ runner: 0, reason: "released", input: 0, detached: false, dangling: [] })]);
    const first = eventsOfInput(outcome.log, handedOver, 0);
    expect(typesOf(first, "session.turn_aborted")).toHaveLength(1);
    expect(typesOf(first, "session.turn_resumed").map((event) => event.data)).toEqual([expect.objectContaining({ reason: "released" })]);
    expect(outcome.requests.map((request) => [request.runner, request.lastUser])).toEqual([[0, FIRST], [1, NEXT]]);
    expect(resultText(first, "call_bash")).toContain("ran call_bash");
  });
});
