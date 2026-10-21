import { describe, expect, it } from "vitest";
import { bash, eventsOfInput, execute, expectResumed, OUTCOME_UNKNOWN_PREFIX, text, usePiSettings, type Outcome, type Scenario } from "./harness.js";

await usePiSettings();

/**
 * Crash points a sweep does not reach on its own: a loss while a request is
 * being streamed or a tool is running, rather than right after a write.
 */

const resultOf = (outcome: Outcome, toolUseId: string) => outcome.log.flatMap((event) =>
  event.type === "agent.tool_result" && (event.data as { toolUseId?: string }).toolUseId === toolUseId ? [event.data as { isError: boolean; content: unknown }]
    : event.type === "agent.context_entry" && (event.data as { entry?: { message?: { role?: string; toolCallId?: string } } }).entry?.message?.toolCallId === toolUseId
      ? [{ isError: false, content: (event.data as { entry: { message: { content: unknown } } }).entry.message.content }] : []);
const assistantEntries = (outcome: Outcome) => outcome.log.filter((event) => event.type === "agent.context_entry" &&
  (event.data as { entry?: { message?: { role?: string } } }).entry?.message?.role === "assistant");

describe("crash injection: losses between durable writes", () => {
  it("A5 lost while the model streams its answer: the takeover asks again, and the lost attempt's Deltas stay apart", async () => {
    const scenario: Scenario = {
      inputs: ["explain the plan"],
      model: (request) => ({ blocks: [text("the plan has three steps")], stop: "end_turn", lostMidStream: request.runner === 0 }),
    };
    const outcome = await execute(scenario);
    expectResumed(scenario, outcome);
    // The lost attempt's request never committed: one answer, from the second request.
    expect(outcome.requests.map((request) => request.runner)).toEqual([0, 1]);
    expect(assistantEntries(outcome)).toHaveLength(1);
    expect(outcome.attempts[1].input.resume).toEqual({ completedModelSteps: 0, blockBase: 0 });
    // Both attempts streamed block 0 of the same Turn; each Delta names its
    // attempt, which is how a console shows only the latest one (#246).
    const [turnId] = new Set(outcome.deltas.map((delta) => delta.turnId));
    expect(new Set(outcome.deltas.map((delta) => [delta.turnId, delta.blockIndex].join()))).toEqual(new Set([`${turnId},0`]));
    expect([...new Set(outcome.deltas.map((delta) => delta.attempt))]).toEqual([1, 2]);
    const answer = assistantEntries(outcome)[0].data as { presentation: { blocks: Array<{ blockIndex?: number }> } };
    expect(answer.presentation.blocks.map((block) => block.blockIndex)).toEqual([0]);
  });

  it("A7 lost while a long bash command runs: the call reports an unknown outcome and is not run again", async () => {
    const scenario: Scenario = {
      inputs: ["run the migration"],
      model: (request) => request.results.has("call_migrate")
        ? { blocks: [text("checked the migration state")], stop: "end_turn" }
        : { blocks: [bash("call_migrate", "./migrate.sh && sleep 600")], stop: "tool_use" },
      // The command is still running in the Sandbox when its Runner is lost.
      tool: (_call, run) => { run.crash(); return new Promise<string>(() => {}); },
    };
    const outcome = await execute(scenario);
    expectResumed(scenario, outcome);
    expect(outcome.toolCalls.map((call) => [call.runner, call.id])).toEqual([[0, "call_migrate"]]);
    expect(resultOf(outcome, "call_migrate")).toEqual([expect.objectContaining({ isError: true,
      content: [{ type: "text", text: expect.stringContaining(OUTCOME_UNKNOWN_PREFIX) }] })]);
    // The model is told, and answers after inspecting: the Turn goes on.
    expect(outcome.requests.at(-1)?.results.get("call_migrate")).toEqual({ isError: true, text: expect.stringContaining(OUTCOME_UNKNOWN_PREFIX) });
  });

  it("A8 lost while one of three parallel calls still runs: none of their results was committed, so all three report an unknown outcome and none runs again", async () => {
    const calls = ["call_a", "call_b", "call_c"];
    const finished = new Set<string>();
    const scenario: Scenario = {
      inputs: ["check three things"],
      model: (request) => calls.every((id) => request.results.has(id))
        ? { blocks: [text("all checked")], stop: "end_turn" }
        : { blocks: calls.map((id) => bash(id, `test -f ${id}`)), stop: "tool_use" },
      tool: async (call, run) => {
        if (call.id !== "call_c") { finished.add(call.id); return `${call.id} ok`; }
        // The other two calls have finished; Pi 0.83 commits a parallel
        // batch's results only once every call of it has finished.
        while (finished.size < 2) await new Promise((resolve) => setTimeout(resolve, 2));
        expect((await run.log()).filter((event) => event.type === "agent.context_entry" &&
          (event.data as { entry?: { message?: { role?: string } } }).entry?.message?.role === "toolResult")).toEqual([]);
        run.crash();
        return new Promise<string>(() => {});
      },
    };
    const outcome = await execute(scenario);
    expectResumed(scenario, outcome);
    expect(outcome.losses).toEqual([expect.objectContaining({ dangling: calls })]);
    expect(outcome.toolCalls.map((call) => call.id).sort()).toEqual(calls);
  });

  it("A16 lost in the middle of a flush: the step it recorded counts, the message it did not commit is asked for again", async () => {
    const scenario: Scenario = {
      inputs: ["clean the workspace"],
      model: (request) => request.results.has("call_bash") ? { blocks: [text("cleaned")], stop: "end_turn" }
        : { blocks: [text("cleaning"), bash("call_bash", "rm -rf build")], stop: "tool_use" },
    };
    const baseline = await execute(scenario);
    // The step's usage and its assistant message are written by one flush; lose the Runner between them.
    const split = baseline.runners[0].writes.findIndex((write) => write.method === "append" &&
      (write.result as { type: string }).type === "span.model_request_end") + 1;
    const outcome = await execute(scenario, [split]);
    expectResumed(scenario, outcome);
    const takeover = outcome.attempts.find((attempt) => attempt.runner === 1)!;
    expect(takeover.log.some((event) => event.type === "span.model_request_end")).toBe(true);
    expect(takeover.log.filter((event) => event.type === "agent.context_entry" &&
      (event.data as { entry?: { message?: { role?: string } } }).entry?.message?.role === "assistant")).toEqual([]);
    expect(takeover.input.resume?.completedModelSteps).toBe(1);
    expect(outcome.toolCalls).toHaveLength(1);
  });

  it("B4 an Interrupt accepted during a compaction, then the Runner is lost: an Interrupted Turn, no boundary, no new request", async () => {
    const long = (label: string) => `${label} ` + "detail ".repeat(80);
    const scenario: Scenario = {
      inputs: [long("first question"), "second question"],
      contextWindow: 2000,
      model: async (request, run) => {
        if (request.summary && run.runner === 0) {
          // The user stops the Turn while its summary is requested; the Runner is lost before it sees the stop.
          expect(await run.requestInterrupt()).toBe(true);
          run.crash();
        }
        return request.summary ? { blocks: [text(`SUMMARY ${request.index}`)], stop: "end_turn" }
          : request.lastUser === "second question" ? { blocks: [text("second answer")], stop: "end_turn", inputTokens: 10 }
          : { blocks: [text(long("first answer"))], stop: "end_turn", inputTokens: 1950 };
      },
    };
    const outcome = await execute(scenario);
    expectResumed(scenario, outcome);
    const first = eventsOfInput(outcome.log, scenario, 0);
    expect(first.filter((event) => event.type === "session.turn_aborted")).toHaveLength(1);
    expect(first.filter((event) => event.type === "agent.context_entry" && (event.data as { entry: { type: string } }).entry.type === "compaction")).toEqual([]);
    // No model request for the interrupted Turn after the loss; the queued input runs afterwards.
    expect(outcome.requests.filter((request) => request.runner > 0).map((request) => request.summary ? "summary" : request.lastUser))
      .toEqual(["summary", "second question"]);
  });
});
