import { describe, expect } from "vitest";
import { sweep, text, usePiSettings, type Outcome, type Scenario } from "./harness.js";

await usePiSettings();

/** A10/A13/A14/G2: two queued inputs, each answered without a tool. */
const scenario: Scenario = {
  inputs: ["first question", "second question"],
  model: (request) => ({ blocks: [text(request.lastUser === "second question" ? "second answer" : "first answer")], stop: "end_turn" }),
};

const answers = (outcome: Outcome) => outcome.log.filter((event) => event.type === "agent.context_entry" &&
  (event.data as { entry?: { message?: { role?: string } } }).entry?.message?.role === "assistant")
  .map((event) => JSON.stringify((event.data as { entry: { message: { content: unknown } } }).entry.message.content));

describe("crash injection: final answers of queued inputs", async () => {
  await sweep(scenario, (outcome) => {
    // A committed final answer completes its Turn: neither answer is given twice,
    // and the queued input runs after the first one, in order.
    expect(answers(outcome)).toEqual([expect.stringContaining("first answer"), expect.stringContaining("second answer")]);
  });
});
