import { describe } from "vitest";
import { bash, sweep, text, usePiSettings, type Scenario } from "./harness.js";

await usePiSettings();

/** A6/A7/A9/A10: one bash call, its result, the final answer. */
const scenario: Scenario = {
  inputs: ["clean the workspace"],
  model: (request) => request.results.has("call_bash")
    ? { blocks: [text("cleaned")], stop: "end_turn" }
    : { blocks: [text("cleaning"), bash("call_bash", "rm -rf build && sleep 30")], stop: "tool_use" },
};

describe("crash injection: a single bash call", async () => {
  await sweep(scenario);
});
