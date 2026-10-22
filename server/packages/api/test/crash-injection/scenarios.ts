import { bash, text, type Scenario } from "./harness.js";

const CALLS = ["call_a", "call_b", "call_c"];

/** A8/A9: three calls in one assistant message, run in parallel, then the answer. */
export const parallelTools: Scenario = {
  inputs: ["check three things"],
  model: (request) => CALLS.every((id) => request.results.has(id))
    ? { blocks: [text("all checked")], stop: "end_turn" }
    : { blocks: [text("checking"), ...CALLS.map((id) => bash(id, `test -f ${id}`))], stop: "tool_use" },
};
