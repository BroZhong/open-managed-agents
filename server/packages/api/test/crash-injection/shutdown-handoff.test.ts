import { describe, expect, it } from "vitest";
import { bash, eventsOfInput, execute, expectResumed, handoffSweep, OUTCOME_UNKNOWN_PREFIX, text, usePiSettings, type Outcome, type Scenario } from "./harness.js";
import { parallelTools } from "./scenarios.js";

await usePiSettings();

/**
 * Graceful shutdown (#254, RECOVERY-MATRIX.md F, G2): a Runner that receives
 * SIGTERM hands its running Turn to the next Runner through the real Pi SDK.
 * Pi stops only at its model request gate, so a tool that finishes within the
 * grace period keeps its real result; a Turn still running at the deadline is
 * detached, its Sandbox process left running.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const markers = (outcome: Outcome) => outcome.log.filter((event) => event.type === "session.turn_resumed").map((event) => event.data);
const runnersOf = (outcome: Outcome) => outcome.requests.filter((request) => !request.summary).map((request) => request.runner);
const calls = (outcome: Outcome) => outcome.toolCalls.map((call) => [call.runner, call.id]);
/** The commands Pi sends to make a running tool wrapper abort (#240). */
const sigterms = (outcome: Outcome) => outcome.commands.filter(({ command }) => command[1] === "-e" && command[2]?.includes("'SIGTERM'"));

describe("graceful shutdown hands the running Turn to the next Runner", () => {
  it("F1 SIGTERM while a tool runs: its result is committed, Pi stops before the next request and the next Runner continues the Turn without running the tool again", async () => {
    const scenario: Scenario = {
      inputs: ["clean the workspace"],
      model: (request) => request.results.has("call_bash")
        ? { blocks: [text("cleaned")], stop: "end_turn" }
        : { blocks: [text("cleaning"), bash("call_bash", "rm -rf build && sleep 3")], stop: "tool_use" },
      // The rollout restarts the Runner while the command runs; it finishes within the grace period.
      tool: async (call, run) => { run.shutDown(); await sleep(30); return `ran ${call.id}`; },
    };
    const outcome = await execute(scenario);
    expectResumed(scenario, outcome);
    expect(outcome.losses).toEqual([expect.objectContaining({ runner: 0, reason: "released", input: 0, detached: false, dangling: [] })]);
    expect(calls(outcome)).toEqual([[0, "call_bash"]]);
    expect(runnersOf(outcome)).toEqual([0, 1]);
    expect(outcome.requests.at(-1)?.results.get("call_bash")).toEqual({ isError: false, text: expect.stringContaining("ran call_bash") });
    expect(markers(outcome)).toEqual([expect.objectContaining({ reason: "released", danglingToolUseIds: [] })]);
  });

  it("F2 SIGTERM, and the tool still runs at the deadline: it is not cancelled, the Turn is detached and the next Runner reports its outcome as unknown", async () => {
    const scenario: Scenario = {
      inputs: ["run the migration"],
      model: (request) => request.results.has("call_migrate")
        ? { blocks: [text("checked the migration state")], stop: "end_turn" }
        : { blocks: [bash("call_migrate", "./migrate.sh && sleep 600")], stop: "tool_use" },
      tool: (_call, run) => { run.shutDown(50); return new Promise<string>(() => {}); },
    };
    const outcome = await execute(scenario);
    expectResumed(scenario, outcome);
    expect(outcome.losses).toEqual([expect.objectContaining({ runner: 0, reason: "released", input: 0, detached: true, dangling: ["call_migrate"] })]);
    // Nothing asked the command to stop: the stopped attempt's executor refused Pi's SIGTERM.
    expect(sigterms(outcome)).toEqual([]);
    expect(calls(outcome)).toEqual([[0, "call_migrate"]]);
    expect(outcome.requests.at(-1)?.results.get("call_migrate")).toEqual({ isError: true, text: expect.stringContaining(OUTCOME_UNKNOWN_PREFIX) });
    expect(markers(outcome)).toEqual([expect.objectContaining({ reason: "released", danglingToolUseIds: ["call_migrate"] })]);
  });

  it("F3 SIGTERM while the model streams: that request finishes, its tool runs and commits, and Pi stops at the next request", async () => {
    const scenario: Scenario = {
      inputs: ["list the files"],
      model: async (request, run) => {
        if (request.results.has("call_ls")) return { blocks: [text("listed")], stop: "end_turn" };
        run.shutDown();
        return { blocks: [text("listing"), bash("call_ls", "ls")], stop: "tool_use" };
      },
    };
    const outcome = await execute(scenario);
    expectResumed(scenario, outcome);
    expect(outcome.losses).toEqual([expect.objectContaining({ runner: 0, reason: "released", detached: false, dangling: [] })]);
    expect(calls(outcome)).toEqual([[0, "call_ls"]]);
    expect(runnersOf(outcome)).toEqual([0, 1]);
  });

  it("F3 SIGTERM while the final answer streams: the Turn completes on its Runner and the queued input goes to the next one", async () => {
    const scenario: Scenario = {
      inputs: ["first question", "second question"],
      model: async (request, run) => {
        if (request.lastUser === "first question") run.shutDown();
        return { blocks: [text(`answer to ${request.lastUser}`)], stop: "end_turn" };
      },
    };
    const outcome = await execute(scenario);
    expectResumed(scenario, outcome);
    // Nothing was handed over: the second input is a Turn of its own.
    expect(outcome.losses).toEqual([{ runner: 0, reason: "released", detached: false, dangling: [] }]);
    expect(runnersOf(outcome)).toEqual([0, 1]);
    expect(markers(outcome)).toEqual([]);
  });

  it("F3 SIGTERM while a final answer streams that fills the context: Pi stops before its compaction's summary request, and the next Runner completes the Turn without a model request", async () => {
    const long = (label: string) => `${label} ` + "detail ".repeat(80);
    const scenario: Scenario = {
      inputs: [long("first question"), "second question"],
      contextWindow: 2000,
      model: async (request, run) => {
        if (!request.summary && request.lastUser.startsWith("first question")) run.shutDown();
        return request.summary ? { blocks: [text(`SUMMARY ${request.index}`)], stop: "end_turn" }
          : request.lastUser === "second question" ? { blocks: [text("second answer")], stop: "end_turn", inputTokens: 10 }
          : { blocks: [text(long("first answer"))], stop: "end_turn", inputTokens: 1950 };
      },
    };
    const outcome = await execute(scenario);
    expectResumed(scenario, outcome);
    expect(outcome.losses).toEqual([expect.objectContaining({ runner: 0, reason: "released", input: 0, detached: false })]);
    // Runner 0 asked for no summary; the next Runner completed the answered Turn, then asked its own.
    expect(outcome.requests.filter((request) => request.runner === 0).map((request) => request.summary)).toEqual([false]);
    expect(outcome.attempts.filter((attempt) => attempt.input.message.content.some((block) => block.type === "text" && block.text.startsWith("first question")))
      .map((attempt) => attempt.runner)).toEqual([0]);
    const first = eventsOfInput(outcome.log, scenario, 0);
    expect(first.filter((event) => event.type === "session.turn_resumed")).toHaveLength(1);
  });

  it("G2 SIGTERM while parallel tools run: every result commits before Pi stops, and the queued inputs run afterwards in order", async () => {
    const ids = ["call_a", "call_b", "call_c"];
    const scenario: Scenario = {
      inputs: ["check three things", "second question", "third question"],
      model: (request) => request.lastUser !== "check three things" ? { blocks: [text(`answer to ${request.lastUser}`)], stop: "end_turn" }
        : ids.every((id) => request.results.has(id)) ? { blocks: [text("all checked")], stop: "end_turn" }
        : { blocks: [text("checking"), ...ids.map((id) => bash(id, `test -f ${id}`))], stop: "tool_use" },
      tool: async (call, run) => {
        // The shutdown begins while the batch runs; the slowest call finishes last.
        if (call.id === "call_a") run.shutDown();
        await sleep(call.id === "call_c" ? 40 : 5);
        return `${call.id} ok`;
      },
    };
    const outcome = await execute(scenario);
    expectResumed(scenario, outcome);
    expect(outcome.losses).toEqual([expect.objectContaining({ runner: 0, reason: "released", input: 0, detached: false, dangling: [] })]);
    expect(outcome.toolCalls.map((call) => call.runner)).toEqual([0, 0, 0]);
    expect(outcome.requests.map((request) => [request.runner, request.lastUser])).toEqual([
      [0, "check three things"], [1, "check three things"], [1, "second question"], [1, "third question"]]);
  });

  it("F6 a rolling restart that replaces each Runner during the Turn's next tool call: the Turn continues on every new Runner, with no recovery error and no unknown outcome", async () => {
    const steps = ["call_0", "call_1", "call_2", "call_3"];
    const scenario: Scenario = {
      inputs: ["migrate in four steps"],
      model: (request) => {
        const next = steps.find((id) => !request.results.has(id));
        return next ? { blocks: [bash(next, `./step ${next}`)], stop: "tool_use" } : { blocks: [text("migrated")], stop: "end_turn" };
      },
      tool: async (call, run) => { run.shutDown(); await sleep(10); return `ran ${call.id}`; },
    };
    const outcome = await execute(scenario);
    expectResumed(scenario, outcome);
    expect(calls(outcome)).toEqual(steps.map((id, runner) => [runner, id]));
    expect(outcome.losses.map((loss) => [loss.runner, loss.reason, loss.detached])).toEqual([0, 1, 2, 3].map((runner) => [runner, "released", false]));
    expect(markers(outcome)).toEqual(steps.map(() => expect.objectContaining({ reason: "released", danglingToolUseIds: [] })));
    expect(runnersOf(outcome)).toEqual([0, 1, 2, 3, 4]);
  });

  it("F7 a handoff, then the new owner is lost mid-tool: the takeovers are marked released, then expired, and the Turn completes", async () => {
    const scenario: Scenario = {
      inputs: ["migrate in two steps"],
      model: (request) => !request.results.has("call_0") ? { blocks: [bash("call_0", "./step 0")], stop: "tool_use" }
        : !request.results.has("call_1") ? { blocks: [bash("call_1", "./step 1")], stop: "tool_use" }
        : { blocks: [text("checked both steps")], stop: "end_turn" },
      tool: async (call, run) => {
        if (run.runner === 0) { run.shutDown(); return `ran ${call.id}`; }
        run.crash();
        return new Promise<string>(() => {});
      },
    };
    const outcome = await execute(scenario);
    expectResumed(scenario, outcome);
    expect(markers(outcome)).toEqual([
      expect.objectContaining({ generation: 2, reason: "released", danglingToolUseIds: [] }),
      expect.objectContaining({ generation: 3, reason: "expired", danglingToolUseIds: ["call_1"] }),
    ]);
    expect(calls(outcome)).toEqual([[0, "call_0"], [1, "call_1"]]);
    expect(outcome.requests.at(-1)?.results.get("call_1")).toEqual({ isError: true, text: expect.stringContaining(OUTCOME_UNKNOWN_PREFIX) });
  });
});

describe("handoff sweep: a single bash call", async () => {
  await handoffSweep({
    inputs: ["clean the workspace", "then report"],
    model: (request) => request.lastUser === "then report" ? { blocks: [text("reported")], stop: "end_turn" }
      : request.results.has("call_bash") ? { blocks: [text("cleaned")], stop: "end_turn" }
      : { blocks: [text("cleaning"), bash("call_bash", "rm -rf build")], stop: "tool_use" },
  });
});

describe("handoff sweep: parallel tools", async () => {
  await handoffSweep(parallelTools);
});
