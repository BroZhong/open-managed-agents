import { describe, expect, it } from "vitest";
import { PendingEventClaimLostError, type StoredEvent } from "@oma-server/store";
import { bash, describeWrite, eventsOfInput, execute, expectResumed, INTERRUPTED_PREFIX, OUTCOME_UNKNOWN_PREFIX, rowOf, sweep, text, usePiSettings, writesOf,
  type Block, type ModelRequest, type Outcome, type Scenario } from "./harness.js";

await usePiSettings();

/**
 * Session-level conditions around a lost Runner (RECOVERY-MATRIX.md G): the
 * Session terminated while no Runner executes it or while the takeover runs,
 * a message sent while the Runner is lost, and Redis gone for the takeover.
 */

const FIRST = "clean the workspace";
const NEXT = "then report";

/** One bash call, its result and the final answer; then a queued input answered at once. */
const scenario: Scenario = {
  inputs: [FIRST, NEXT],
  model: (request) => request.lastUser === NEXT ? { blocks: [text("reported")], stop: "end_turn" }
    : request.results.has("call_bash") ? { blocks: [text("cleaned")], stop: "end_turn" }
    : { blocks: [text("cleaning"), bash("call_bash", "rm -rf build")], stop: "tool_use" },
};
const lostMidTool: Scenario = { ...scenario, tool: (_call, run) => { run.crash(); return new Promise<string>(() => {}); } };

const typesOf = (log: StoredEvent[], ...types: string[]) => log.filter((event) => types.includes(event.type));

/** Nothing ran the Session after it was terminated, and its Sandbox was released. */
async function expectTerminated(outcome: Outcome, logAtTermination: StoredEvent[]): Promise<void> {
  expect((await outcome.stores.sessionStore.getById(outcome.sessionId))?.status).toBe("terminated");
  expect(await outcome.stores.pendingEventStore.count(outcome.sessionId)).toBe(0);
  // Not one row after the termination, so no terminal event and no repair either.
  expect(outcome.log.map((event) => event.seq)).toEqual(logAtTermination.map((event) => event.seq));
  // The cleanup sweep of a live Runner disposed the Sandbox the lost one left.
  expect(outcome.disposals.filter((runner) => runner > 0)).not.toEqual([]);
}

describe("G1 the Session is terminated while its Runner is lost", () => {
  it("G1 lost while its bash runs, terminated before the takeover: nothing resumes it, its queue is cleared and its Sandbox released", async () => {
    let logAtTermination: StoredEvent[] = [];
    const outcome = await execute({ ...lostMidTool, afterLoss: async (run) => { await run.terminate(); logAtTermination = await run.log(); } });
    await expectTerminated(outcome, logAtTermination);
    expect(outcome.runners).toHaveLength(2);
    expect(outcome.attempts.map((attempt) => attempt.runner)).toEqual([0]);
    expect(outcome.requests.map((request) => request.runner)).toEqual([0]);
    expect(outcome.toolCalls.map((call) => call.runner)).toEqual([0]);
    expect(outcome.errors).toEqual([]);
  });

  describe("G1 crash injection: terminated after the Runner is lost after each of its writes", async () => {
    const writes = await writesOf(scenario);
    it.each(writes.map((write, index) => [rowOf(writes, index), index + 1, describeWrite(write)] as const))(
      "%s Runner 0 lost after write %i (%s), then the Session is terminated: nothing runs it again",
      async (_row, n) => {
        let logAtTermination: StoredEvent[] = [];
        const outcome = await execute({ ...scenario, afterLoss: async (run) => { await run.terminate(); logAtTermination = await run.log(); } }, [n]);
        await expectTerminated(outcome, logAtTermination);
        expect(outcome.attempts.filter((attempt) => attempt.runner > 0)).toEqual([]);
        expect(outcome.requests.filter((request) => request.runner > 0)).toEqual([]);
        expect(outcome.errors).toEqual([]);
      });
  });
});

describe("G8 a parent Session is terminated while its child's Runner is lost", () => {
  it("G8 the child's takeover stops the child's Turn as an Interrupted Turn without asking its model, and nothing runs for the parent", async () => {
    const PARENT = "summarise the build";
    const fromChild = (request: ModelRequest) => !request.text.includes(PARENT);
    const agent: Block = { type: "tool_use", id: "call_agent", name: "Agent", input: { prompt: "inspect the build" } };
    let logAtTermination: StoredEvent[] = [];
    const scenario: Scenario = {
      inputs: [PARENT],
      children: "apart",
      model: (request) => fromChild(request)
        ? request.results.has("call_inspect") ? { blocks: [text("green")], stop: "end_turn" } : { blocks: [bash("call_inspect", "make check")], stop: "tool_use" }
        : request.results.has("call_agent") ? { blocks: [text("done")], stop: "end_turn" } : { blocks: [text("delegating"), agent], stop: "tool_use" },
      // The child's Runner is lost while its bash runs; the user terminates the parent meanwhile.
      tool: (_call, run) => { run.crash(); return new Promise<string>(() => {}); },
      afterLoss: async (run) => { await run.terminate(); logAtTermination = await run.log(); },
    };
    const outcome = await execute(scenario);
    const [execution] = outcome.executions;
    const child = outcome.sessions[1];
    expect(execution).toMatchObject({ status: "interrupted", notificationStatus: "suppressed" });
    expect(child.log.filter((event) => event.type === "session.turn_aborted")).toHaveLength(1);
    expect(child.log.map((event) => event.type).slice(-6)).toEqual(["session.turn_resumed", "session.interrupt_requested", "agent.tool_result",
      "session.turn_aborted", "session.turn_completed", "session.status_idle"]);
    expect(JSON.stringify(child.log.filter((event) => event.type === "agent.tool_result").map((event) => event.data))).toContain(INTERRUPTED_PREFIX);
    expect(outcome.requests.map((request) => request.runner)).toEqual([0, 1]);
    expect(outcome.toolCalls.map((call) => call.runner)).toEqual([1]);
    // The parent's log gained only the child's outcome record; no Turn ran for it.
    expect(outcome.log.slice(logAtTermination.length).map((event) => event.type)).toEqual(["subagent.result"]);
    for (const session of outcome.sessions) expect(await outcome.stores.pendingEventStore.count(session.id)).toBe(0);
    expect((await outcome.stores.sessionStore.getById(outcome.sessionId))?.status).toBe("terminated");
    // The parent's Runner learned of the termination as a lost lease and stopped.
    expect(outcome.errors.map(({ runner, error }) => [runner, (error as Error).name])).toEqual([[0, "PendingLeaseLostError"]]);
    expect(outcome.disposals).not.toEqual([]);
  });
});

describe("G6 the Session is terminated while the takeover runs its Turn", () => {
  /** The takeover's own stop: its next write finds the claim gone, so it stops like a lost lease. */
  const expectStoppedTakeover = (outcome: Outcome) => {
    expect(outcome.errors).toEqual([expect.objectContaining({ runner: 1, error: expect.any(PendingEventClaimLostError) })]);
    // The takeover had marked itself and answered the dangling call; it wrote no terminal event.
    const types = outcome.log.map((event) => event.type);
    expect(types).toContain("session.turn_resumed");
    expect(typesOf(outcome.log, "session.turn_completed", "session.turn_aborted", "session.error", "session.status_idle")).toEqual([]);
    expect(outcome.requests.filter((request) => request.lastUser === NEXT)).toEqual([]);
  };

  it("G6 terminated while the takeover's model request is in flight: the answer is never committed and nothing more runs", async () => {
    let logAtTermination: StoredEvent[] = [];
    const outcome = await execute({ ...lostMidTool,
      model: async (request, run) => {
        if (run.runner === 1) { await run.terminate(); logAtTermination = await run.log(); }
        return lostMidTool.model(request, run);
      } });
    await expectTerminated(outcome, logAtTermination);
    expectStoppedTakeover(outcome);
    expect(outcome.requests.map((request) => request.runner)).toEqual([0, 1]);
    expect(outcome.requests[1].results.get("call_bash")).toEqual({ isError: true, text: expect.stringContaining(OUTCOME_UNKNOWN_PREFIX) });
  });

  it("G6 terminated while the takeover's own bash runs: its result is never committed and no model request follows", async () => {
    let logAtTermination: StoredEvent[] = [];
    const outcome = await execute({ ...scenario,
      model: (request) => request.results.has("call_second") ? { blocks: [text("done")], stop: "end_turn" }
        : request.results.has("call_bash") ? { blocks: [bash("call_second", "make")], stop: "tool_use" }
        : { blocks: [bash("call_bash", "rm -rf build")], stop: "tool_use" },
      tool: async (call, run) => {
        if (run.runner === 0) { run.crash(); return new Promise<string>(() => {}); }
        await run.terminate();
        logAtTermination = await run.log();
        return `ran ${call.id}`;
      } });
    await expectTerminated(outcome, logAtTermination);
    expectStoppedTakeover(outcome);
    expect(outcome.toolCalls.map((call) => [call.runner, call.id])).toEqual([[0, "call_bash"], [1, "call_second"]]);
    expect(outcome.requests.map((request) => request.runner)).toEqual([0, 1]);
  });
});

describe("G5 a message sent while the Runner is lost", () => {
  it("G5 sent while the Turn's Runner is lost: it waits behind the resumed Turn and runs after it", async () => {
    const LATE = "and summarise it";
    const scenario: Scenario = { ...lostMidTool,
      model: (request, run) => request.lastUser === LATE ? { blocks: [text("summarised")], stop: "end_turn" } : lostMidTool.model(request, run),
      afterLoss: (run) => run.send(LATE) };
    const outcome = await execute(scenario);
    expectResumed(scenario, outcome);
    expect(outcome.sessions[0].inputs).toEqual([FIRST, NEXT, LATE]);
    expect(outcome.requests.filter((request) => !request.summary).map((request) => [request.runner, request.lastUser]))
      .toEqual([[0, FIRST], [1, FIRST], [1, NEXT], [1, LATE]]);
  });

  describe("G5 crash injection: a message sent while the Runner is lost after each of its writes", async () => {
    await sweep({ ...scenario, afterLoss: (run) => run.send("and summarise it") }, (outcome) => {
      // The message ran last, after every input queued before the loss.
      const answered = outcome.requests.filter((request) => !request.summary).map((request) => request.lastUser);
      expect(answered.at(-1)).toBe("and summarise it");
      expect(eventsOfInput(outcome.log, outcome.sessions[0], 2).filter((event) => event.type === "session.turn_completed")).toHaveLength(1);
    });
  });
});

describe("G3 Redis is unavailable", () => {
  it("G3 to the Runner that takes the Turn over: the Turn completes from PostgreSQL alone, with no Delta of the takeover", async () => {
    const scenario: Scenario = { ...lostMidTool, redisDown: (runner) => runner > 0 };
    const outcome = await execute(scenario);
    expectResumed(scenario, outcome);
    expect(outcome.losses).toEqual([expect.objectContaining({ runner: 0, input: 0, dangling: ["call_bash"] })]);
    expect(outcome.requests.map((request) => request.runner)).toEqual([0, 1, 1]);
    // Only the lost Runner's Deltas reached Redis.
    expect(outcome.deltas.length).toBeGreaterThan(0);
    expect(outcome.deltas.every((delta) => delta.attempt === 1)).toBe(true);
    expect(JSON.stringify(eventsOfInput(outcome.log, scenario, 0).map((event) => event.data))).toContain("cleaned");
  });

  describe("G3 crash injection: Redis is down for every Runner, lost after each write", async () => {
    await sweep({ ...scenario, redisDown: () => true }, (outcome) => expect(outcome.deltas).toEqual([]));
  });
});
