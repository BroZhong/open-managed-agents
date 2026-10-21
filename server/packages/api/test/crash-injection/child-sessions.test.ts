import { describe, expect, it } from "vitest";
import type { StoredEvent } from "@oma-server/store";
import { bash, eventsOfInput, execute, expectResumed, INTERRUPTED_PREFIX, OUTCOME_UNKNOWN_PREFIX, sweep, text, usePiSettings,
  type Block, type ModelRequest, type Outcome, type Scenario, type SessionOutcome } from "./harness.js";

await usePiSettings();

/**
 * A Child Session's Turn continues on another Runner like any other Turn
 * (#252): the claim that takes its input over takes its Delegation Execution
 * over, the parent's synchronous wait receives the child's real result, the
 * step budget continues from the log, a running sibling keeps its slot of the
 * parent's limit until it ends, and an Interrupt the parent asked for before
 * the child's Runner was lost ends the child's Turn as an Interrupted Turn.
 */

const PARENT_INPUT = "summarise the build";
const CHILD_TASK = "inspect the build";
const CHILD_ANSWER = "the build is green";
const INSPECT = "call_inspect";

const agent = (id: string, prompt: string): Block => ({ type: "tool_use", id, name: "Agent", input: { prompt } });
const answer = (value: string) => ({ blocks: [text(value)], stop: "end_turn" as const });
const use = (...blocks: Block[]) => ({ blocks, stop: "tool_use" as const });
/** A Child Session's request: the parent's conversation is not copied into it. */
const fromChild = (request: ModelRequest) => !request.text.includes(PARENT_INPUT);
/** The value a delegation tool's result carries, as the model received it. */
function resultOf(request: ModelRequest, toolUseId: string): Record<string, unknown> {
  const content = JSON.parse(request.results.get(toolUseId)!.text) as string | Array<{ type: string; text: string }>;
  return JSON.parse(typeof content === "string" ? content : content[0].text) as Record<string, unknown>;
}
const unknown = (request: ModelRequest, toolUseId: string) => request.results.get(toolUseId)?.text.includes(OUTCOME_UNKNOWN_PREFIX) ?? false;

/** The parent delegates synchronously; the child runs one bash command and answers. */
function delegation(overrides: Partial<Scenario> = {}): Scenario {
  return {
    inputs: [PARENT_INPUT],
    model: (request) => {
      if (fromChild(request)) return request.results.has(INSPECT) ? answer(CHILD_ANSWER) : use(text("inspecting"), bash(INSPECT, "make check"));
      if (!request.results.has("call_agent")) return use(text("delegating"), agent("call_agent", CHILD_TASK));
      // A takeover that lost the call before its delegation was accepted cannot know the child's result (C3).
      return answer(unknown(request, "call_agent") ? "the delegation's outcome is unknown" : `the child says: ${CHILD_ANSWER}`);
    },
    ...overrides,
  };
}

const child = (outcome: Outcome): SessionOutcome => outcome.sessions[1];
const markers = (log: StoredEvent[]) => log.filter((event) => event.type === "session.turn_resumed").map((event) => event.data);
const typesOf = (log: StoredEvent[], ...types: string[]) => log.filter((event) => types.includes(event.type));
async function until(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  for (const start = Date.now(); !await check();) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
/** The parent's last model request, which carries the child's result. */
const parentAnswered = (outcome: Outcome) => outcome.requests.filter((request) => !fromChild(request)).at(-1)!;

/**
 * The synchronous delegation completed: one child, its execution completed
 * with the child's answer, and the parent's wait handed it to the parent's
 * Turn, or no delegation was accepted before the loss (C3) and the parent
 * was told the call's outcome is unknown.
 */
function expectDelegated(outcome: Outcome, output = CHILD_ANSWER): void {
  expect(outcome.executions.length).toBeLessThanOrEqual(1);
  const [execution] = outcome.executions;
  if (!execution) {
    expect(unknown(parentAnswered(outcome), "call_agent")).toBe(true);
    return;
  }
  const result = { output };
  expect(execution).toMatchObject({ status: "completed", result, notificationStatus: "consumed" });
  expect(resultOf(parentAnswered(outcome), "call_agent")).toMatchObject({ executionId: execution.id, status: "completed",
    turnId: execution.turnId, result });
  // The child's Turn is the one its execution names, however many Runners ran it.
  expect(eventsOfInput(child(outcome).log, child(outcome), 0).filter((event) => event.type === "session.turn_completed")
    .map((event) => (event.data as { turnId: string }).turnId)).toEqual([execution.turnId]);
}

describe("crash injection: a Child Session loses its Runner (#252)", () => {
  it("C7 the child's Runner is lost while its bash runs: the child resumes in the same Turn and the parent's wait gets its real result", async () => {
    const scenario = delegation({
      children: "apart",
      // The parent's Runner 0 waits on; the child's Runner 1 is lost while the command runs.
      tool: (_call, run) => { run.crash(); return new Promise<string>(() => {}); },
    });
    const baseline = await execute(delegation({ children: "apart" }));
    const outcome = await execute(scenario);
    expectResumed(scenario, outcome);
    expectDelegated(outcome);
    const [execution] = outcome.executions;
    expect(outcome.losses).toEqual([expect.objectContaining({ runner: 1, sessionId: execution.childId, input: 0, dangling: [INSPECT] })]);
    // The parent never moved: no takeover, one wait, answered by its own Runner.
    expect(markers(outcome.log)).toEqual([]);
    expect(parentAnswered(outcome).runner).toBe(0);
    // The child continued its Turn on the Runner that replaced its own: the
    // command is reported as of unknown outcome and not run again.
    expect(markers(child(outcome).log)).toEqual([{ turnId: execution.turnId, generation: 2, reason: "expired", danglingToolUseIds: [INSPECT] }]);
    expect(outcome.toolCalls.map((call) => [call.runner, call.id])).toEqual([[1, INSPECT]]);
    const childRequests = outcome.requests.filter(fromChild);
    expect(childRequests.map((request) => request.runner)).toEqual([1, 2]);
    expect(childRequests[1].results.get(INSPECT)).toEqual({ isError: true, text: expect.stringContaining(OUTCOME_UNKNOWN_PREFIX) });
    const resumed = outcome.attempts.find((attempt) => attempt.input.sessionId === execution.childId && attempt.runner === 2)!;
    expect(resumed.input).toMatchObject({ turnId: execution.turnId, resume: { completedModelSteps: 1 }, execution: { isChild: true, maxModelSteps: 500 } });
    // The execution keeps the configuration its Turn resolved first, labels included.
    expect(execution).toMatchObject({ ownerId: "runner-2", generation: 2 });
    expect(execution.effectiveConfig).toEqual(baseline.executions[0].effectiveConfig);
  });

  it("C8 both Runners are lost, the parent's while it waits and the child's while its bash runs: both resume and the result is delivered once", async () => {
    const scenario = delegation({
      children: "apart",
      tool: (_call, run) => { run.lose("parent"); run.crash(); return new Promise<string>(() => {}); },
    });
    const outcome = await execute(scenario);
    expectResumed(scenario, outcome);
    expectDelegated(outcome);
    const [execution] = outcome.executions;
    expect(outcome.losses.map((loss) => [loss.runner, loss.sessionId, loss.dangling])).toEqual(expect.arrayContaining([
      [0, outcome.sessionId, ["call_agent"]], [1, execution.childId, [INSPECT]]]));
    // The parent resumed its wait, the child its Turn; one result reached the parent, from the record.
    expect(markers(outcome.log)).toEqual([expect.objectContaining({ reason: "expired", danglingToolUseIds: ["call_agent"] })]);
    expect(markers(child(outcome).log)).toEqual([expect.objectContaining({ reason: "expired", danglingToolUseIds: [INSPECT] })]);
    expect(outcome.requests.filter((request) => !fromChild(request) && request.results.has("call_agent"))).toHaveLength(1);
  });

  it("C2 the parent's Runner is lost while it waits and the child completes before any Runner takes the parent over: the takeover consumes the result and continues", async () => {
    const scenario = delegation({
      children: "apart",
      model: (request, run) => {
        if (fromChild(request) && request.results.has(INSPECT)) run.lose("parent");
        return delegation().model(request, run);
      },
      // Nothing takes the parent over until the child has completed.
      afterLoss: (run) => until(async () => (await run.executions())[0]?.status === "completed"),
    });
    const outcome = await execute(scenario);
    expectResumed(scenario, outcome);
    expectDelegated(outcome);
    expect(outcome.losses).toEqual([expect.objectContaining({ runner: 0, sessionId: outcome.sessionId, dangling: ["call_agent"] })]);
    expect(markers(child(outcome).log)).toEqual([]);
    // The takeover found the result waiting, consumed it in the same Turn and continued from the step it reached.
    const [completedAt] = typesOf(child(outcome).log, "session.turn_completed");
    const [resumedAt] = typesOf(outcome.log, "session.turn_resumed");
    expect(resumedAt.ts.getTime()).toBeGreaterThanOrEqual(completedAt.ts.getTime());
    const takeover = outcome.attempts.find((attempt) => attempt.input.sessionId === outcome.sessionId && attempt.input.resume)!;
    expect(takeover.input.resume?.completedModelSteps).toBe(1);
    expect(takeover.input.turnId).toBe(outcome.attempts[0].input.turnId);
  });
});

describe("F4 the Runner of a synchronous child shuts down (#254)", () => {
  it("F4 SIGTERM while the child's bash runs: the command finishes, the child's Turn is handed over and continued, and the parent's wait gets its real result", async () => {
    const scenario = delegation({
      children: "apart",
      // The rollout restarts the child's Runner while the command runs; it finishes within the grace period.
      tool: async (call, run) => { run.shutDown(); await new Promise((resolve) => setTimeout(resolve, 30)); return `ran ${call.id}`; },
    });
    const outcome = await execute(scenario);
    expectResumed(scenario, outcome);
    expectDelegated(outcome);
    const [execution] = outcome.executions;
    expect(outcome.losses).toEqual([expect.objectContaining({ runner: 1, sessionId: execution.childId, reason: "released", detached: false, dangling: [] })]);
    // The command ran once, on the Runner that shut down; its real result reached the child's next request on the next Runner.
    expect(outcome.toolCalls.map((call) => [call.runner, call.id])).toEqual([[1, INSPECT]]);
    const childRequests = outcome.requests.filter(fromChild);
    expect(childRequests.map((request) => request.runner)).toEqual([1, 2]);
    expect(childRequests[1].results.get(INSPECT)).toEqual({ isError: false, text: expect.stringContaining(`ran ${INSPECT}`) });
    expect(markers(child(outcome).log)).toEqual([{ turnId: execution.turnId, generation: 2, reason: "released", danglingToolUseIds: [] }]);
    expect(execution).toMatchObject({ ownerId: "runner-2", generation: 2 });
    // The parent waited on its own Runner throughout.
    expect(markers(outcome.log)).toEqual([]);
    expect(parentAnswered(outcome).runner).toBe(0);
  });

  describe("F4 handoff sweep: the child's Runner shuts down after each of its writes", async () => {
    const scenario = delegation({ children: "apart" });
    const writes = (await execute(scenario)).runners[1].writes;
    it.each(writes.map((_write, index) => index + 1))("child Runner shut down after its write %i: the child's Turn is handed over and the parent gets its result", async (n) => {
      const outcome = await execute(scenario, [], [undefined, n]);
      expectResumed(scenario, outcome);
      expectDelegated(outcome);
      expect(outcome.losses.filter((loss) => loss.runner === 1).every((loss) => loss.reason === "released" && !loss.detached)).toBe(true);
      expect(markers(child(outcome).log).map((marker) => (marker as { reason: string }).reason).filter((reason) => reason !== "released")).toEqual([]);
      expect(markers(outcome.log)).toEqual([]);
    });
  });
});

describe("C7 crash injection: the child's Runner is lost after each of its writes, the parent's Runner waits on", async () => {
  await sweep(delegation({ children: "apart" }), (outcome) => {
    expectDelegated(outcome);
    // The parent never moved; its wait received the result on its own Runner.
    expect(markers(outcome.log)).toEqual([]);
    expect(parentAnswered(outcome).runner).toBe(0);
  }, { runner: 1 });
});

describe("C1 crash injection: the parent's Runner is lost after each of its writes, the child runs on", async () => {
  await sweep(delegation({ children: "apart" }), (outcome) => {
    expectDelegated(outcome);
    // A loss before the delegation was accepted left no child (C3).
    if (outcome.executions.length) expect(markers(child(outcome).log)).toEqual([]);
  });
});

describe("C8 crash injection: one Runner runs parent and child and is lost after each of its writes", async () => {
  await sweep(delegation(), (outcome) => expectDelegated(outcome));
});

const STEERING = "verify the cache first";
/** The child is steered while its bash runs, as the parent's steer_subagent would steer it; the instruction must reach its model. */
const steered = (overrides: Partial<Scenario> = {}): Scenario => delegation({
  children: "apart",
  model: (request, run) => fromChild(request) && request.results.has(INSPECT)
    ? answer(request.text.includes(STEERING) ? `${CHILD_ANSWER}, cache verified` : CHILD_ANSWER)
    : delegation().model(request, run),
  tool: async (_call, run) => {
    const [execution] = await run.executions();
    await run.stores.delegationStore.command({ tenantId: "tenant", callerSessionId: run.sessionId, callerTurnId: execution.callerTurnId,
      callerToolUseId: "call_steer", childId: execution.childId, executionId: execution.id, kind: "steer", message: STEERING });
    return "ok";
  },
  ...overrides,
});
/** The instruction was applied once and reached the child's model, unless the loss came before the bash that steered it ran. */
async function expectSteered(outcome: Outcome): Promise<void> {
  if (!outcome.toolCalls.length) { expectDelegated(outcome); return; }
  expectDelegated(outcome, `${CHILD_ANSWER}, cache verified`);
  const [execution] = outcome.executions;
  expect(await outcome.stores.delegationStore.listCommands(execution.id)).toEqual([expect.objectContaining({ kind: "steer", status: "applied" })]);
  expect(typesOf(child(outcome).log, "subagent.instruction")).toHaveLength(1);
}

describe("C9 the child's steering instruction is the last thing its log holds when its Runner is lost", () => {
  it("C9 lost right after the instruction was applied: the takeover continues, and the instruction reaches the model once", async () => {
    const scenario = steered();
    const outcome = await execute(scenario, [undefined, (write) => write.method === "applyCommand"]);
    expectResumed(scenario, outcome);
    await expectSteered(outcome);
    // The instruction was the last thing the lost attempt wrote; the takeover continued after it.
    const log = child(outcome).log;
    const resumedAt = log.findIndex((event) => event.type === "session.turn_resumed");
    expect(log[resumedAt - 1].type).toBe("subagent.instruction");
    expect(outcome.attempts.find((attempt) => attempt.runner === 2)!.input.resume).toBeDefined();
    expect(outcome.requests.filter(fromChild).map((request) => request.runner)).toEqual([1, 2]);
  });

  describe("C9 crash injection: the child's Runner is lost after each of its writes around the instruction", async () => {
    await sweep(steered(), expectSteered, { runner: 1 });
  });
});

describe("C10 siblings whose owner was lost keep their slot", () => {
  it("C10 one slot, two synchronous children, the running one's Runner is lost: it resumes in its slot, the other waits for it, none ends recovery_required", async () => {
    const tasks: Record<string, string> = { call_api: "inspect the api", call_web: "inspect the web" };
    let mostRunning = 0;
    const scenario: Scenario = {
      inputs: [PARENT_INPUT],
      children: "apart",
      maxChildren: 1,
      model: async (request, run) => {
        if (fromChild(request)) {
          mostRunning = Math.max(mostRunning, (await run.executions()).filter((execution) => execution.status === "running").length);
          // The child's task arrives as its delegation input.
          const task = Object.values(tasks).find((candidate) => request.lastUser.includes(candidate))!;
          const id = `bash_${task.split(" ").at(-1)}`;
          return request.results.has(id) ? answer(`${task}: green`) : use(bash(id, "make check"));
        }
        return Object.keys(tasks).every((id) => request.results.has(id)) ? answer("both are green")
          : use(text("delegating"), ...Object.entries(tasks).map(([id, task]) => agent(id, task)));
      },
      // The first child to run loses its Runner while its bash runs.
      tool: (_call, run) => {
        if (run.runner !== 1) return "ok";
        run.crash();
        return new Promise<string>(() => {});
      },
    };
    const outcome = await execute(scenario);
    expectResumed(scenario, outcome);
    expect(mostRunning).toBe(1);
    expect(outcome.executions.map((execution) => execution.status)).toEqual(["completed", "completed"]);
    const [lost] = outcome.losses;
    const first = outcome.executions.find((execution) => execution.childId === lost.sessionId)!;
    const second = outcome.executions.find((execution) => execution !== first)!;
    // The lost child kept running in its slot until its takeover finished it; only then did its sibling start.
    expect(markers(outcome.sessions.find((session) => session.id === first.childId)!.log))
      .toEqual([expect.objectContaining({ reason: "expired", danglingToolUseIds: [`bash_${first.prompt.split(" ").at(-1)}`] })]);
    const [firstCompleted] = typesOf(outcome.sessions.find((session) => session.id === first.childId)!.log, "session.turn_completed");
    const [secondRunning] = typesOf(outcome.sessions.find((session) => session.id === second.childId)!.log, "session.status_running");
    expect(secondRunning.ts.getTime()).toBeGreaterThanOrEqual(firstCompleted.ts.getTime());
    for (const [id, task] of Object.entries(tasks)) {
      expect(resultOf(parentAnswered(outcome), id)).toMatchObject({ status: "completed", result: { output: `${task}: green` } });
    }
  });
});

describe("C11 a child's step budget across takeovers", () => {
  const STEPS = 3;
  /** The child runs one more bash command at every step until its budget ends the execution. */
  const exhausting = (overrides: Partial<Scenario> = {}): Scenario => delegation({
    children: "apart",
    childSteps: STEPS,
    errors: ["model_step_budget_exhausted"],
    model: (request, run) => fromChild(request) ? use(bash(`call_${request.results.size + 1}`, "make check"))
      : request.results.has("call_agent") ? answer(`the child ended ${resultOf(request, "call_agent").status as string}`)
      : delegation().model(request, run),
    ...overrides,
  });
  function expectExhausted(outcome: Outcome): void {
    const [execution] = outcome.executions;
    expect(execution).toMatchObject({ status: "budget_exhausted", maxSteps: STEPS });
    expect(resultOf(parentAnswered(outcome), "call_agent")).toMatchObject({ status: "budget_exhausted", budget: { maxModelSteps: STEPS } });
    // Every step the log records counts against the budget, whichever Runner
    // made it: the count never restarts, so the child asks the model at most
    // the budget's steps, and a loss right after a step's record costs at most
    // that one step, which never reached the model.
    const log = child(outcome).log;
    const asked = outcome.requests.filter(fromChild).length;
    expect(asked).toBeLessThanOrEqual(STEPS);
    expect(asked).toBeGreaterThanOrEqual(STEPS - outcome.losses.filter((loss) => loss.sessionId === execution.childId).length);
    expect(typesOf(log, "session.error").map((event) => (event.data as { error: { code: string } }).error.code)).toEqual(["model_step_budget_exhausted"]);
  }

  it("C11 the child's Runner is lost at its second step: the takeover continues from two steps and the budget ends it at the third", async () => {
    const scenario = exhausting({ tool: (call, run) => {
      if (call.id !== "call_2") return "ok";
      run.crash();
      return new Promise<string>(() => {});
    } });
    const outcome = await execute(scenario);
    expectResumed(scenario, outcome);
    expectExhausted(outcome);
    const takeover = outcome.attempts.find((attempt) => attempt.input.sessionId === outcome.executions[0].childId && attempt.runner === 2)!;
    expect(takeover.input.resume?.completedModelSteps).toBe(2);
    expect(outcome.requests.filter(fromChild).map((request) => request.runner)).toEqual([1, 1, 2]);
  });

  describe("C11 crash injection: the child's Runner is lost after each of its writes", async () => {
    await sweep(exhausting(), expectExhausted, { runner: 1 });
  });
});

describe("C12 the parent is interrupted while it waits, and a Runner is lost", () => {
  it("C12 the child's Runner is lost before it applied the parent's Interrupt: the takeover applies it and ends the child's Turn as an Interrupted Turn", async () => {
    const scenario = delegation({
      children: "apart",
      tool: (_call, run) => { run.crash(); return new Promise<string>(() => {}); },
      // While no Runner owns the child, the user stops the parent, whose Runner asks the child to stop.
      afterLoss: async (run) => {
        expect(await run.interrupt(run.sessionId)).toBe(true);
        await until(async () => (await run.log()).some((event) => event.type === "session.turn_completed"));
      },
    });
    const outcome = await execute(scenario);
    expectResumed(scenario, outcome);
    const [execution] = outcome.executions;
    expect(execution).toMatchObject({ status: "interrupted" });
    const [command, ...others] = await outcome.stores.delegationStore.listCommands(execution.id);
    expect(others).toEqual([]);
    expect(command).toMatchObject({ kind: "interrupt", status: "applied" });
    // The parent's Turn is an Interrupted Turn; the child's takeover asked its model nothing.
    expect(typesOf(outcome.log, "session.turn_aborted")).toHaveLength(1);
    expect(outcome.requests.filter(fromChild).map((request) => request.runner)).toEqual([1]);
    const log = child(outcome).log;
    expect(log.map((event) => event.type).slice(-6)).toEqual(["session.turn_resumed", "session.interrupt_requested", "agent.tool_result",
      "session.turn_aborted", "session.turn_completed", "session.status_idle"]);
    expect(typesOf(log, "session.interrupt_requested")[0].data).toMatchObject({ commandId: command.id, source: "delegation" });
    expect(JSON.stringify(typesOf(log, "agent.tool_result")[0].data)).toContain(INTERRUPTED_PREFIX);
  });

  /** The user stops the parent while the child's bash runs; the bash returns once the child's owner has seen the stop. */
  const interrupted = delegation({
    tool: async (_call, run) => {
      await run.interrupt(run.sessionId);
      const settled = async () => {
        const [execution] = await run.executions();
        return (await run.stores.delegationStore.listCommands(execution.id)).some((command) => command.status !== "accepted");
      };
      await until(settled).catch(() => {});
      return "ok";
    },
  });
  describe("C12 crash injection: one Runner runs parent and child and is lost after each of its writes", async () => {
    await sweep(interrupted, async (outcome) => {
      const [execution] = outcome.executions;
      // A loss before the child's bash ran never asked to stop anything.
      if (!outcome.toolCalls.length) { expectDelegated(outcome); return; }
      expect(typesOf(eventsOfInput(outcome.log, { inputs: [PARENT_INPUT] }, 0), "session.turn_aborted")).toHaveLength(1);
      expect(["interrupted", "completed"]).toContain(execution.status);
      if (execution.status === "interrupted") {
        expect(typesOf(child(outcome).log, "session.turn_aborted")).toHaveLength(1);
        expect(await outcome.stores.delegationStore.listCommands(execution.id)).toEqual([expect.objectContaining({ kind: "interrupt", status: "applied" })]);
      }
    });
  });
});

describe("E1 a poison Child Session", { timeout: 30_000 }, () => {
  it("E1/C7 the child loses its Runner at the same point every time: its fourth takeover ends it, and the parent's wait gets recovery_required", async () => {
    const scenario = delegation({
      children: "apart",
      errors: ["recovery_limit_exceeded"],
      model: (request, run) => fromChild(request) ? { blocks: [text("here is the whole build log")], stop: "end_turn", lostMidStream: true }
        : request.results.has("call_agent") ? answer(`the child ended ${resultOf(request, "call_agent").status as string}`)
        : delegation().model(request, run),
    });
    const outcome = await execute(scenario);
    expectResumed(scenario, outcome);
    const [execution] = outcome.executions;
    expect(execution).toMatchObject({ status: "recovery_required", result: { reason: expect.stringContaining("lost 4 times") } });
    expect(outcome.losses.map((loss) => [loss.runner, loss.sessionId])).toEqual([1, 2, 3, 4].map((runner) => [runner, execution.childId]));
    expect(typesOf(child(outcome).log, "session.error").map((event) => (event.data as { error: { code: string } }).error.code)).toEqual(["recovery_limit_exceeded"]);
    // The parent was never lost: its wait received the child's outcome, and its Turn completed without an error.
    expect(resultOf(parentAnswered(outcome), "call_agent")).toMatchObject({ status: "recovery_required", executionId: execution.id });
    expect(markers(outcome.log)).toEqual([]);
    expect(typesOf(outcome.log, "session.error")).toEqual([]);
  });
});
