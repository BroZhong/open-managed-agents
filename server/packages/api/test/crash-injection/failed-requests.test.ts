import { describe, expect } from "vitest";
import { bash, sweep, text, usePiSettings, type Outcome, type Scenario } from "./harness.js";

await usePiSettings();

/** A11: the Turn's first request fails with a retryable error; Pi retries it and the Turn goes on. */
const retried: Scenario = {
  inputs: ["list the files"],
  model: (request) => request.index === 0 ? { error: { status: 503, type: "overloaded_error", message: "Overloaded" } }
    : request.results.has("call_ls") ? { blocks: [text("listed")], stop: "end_turn" }
    : { blocks: [bash("call_ls", "ls")], stop: "tool_use" },
};

/** A12: every request fails for good; the Turn ends with the Adapter's error, recorded once. */
const failing: Scenario = {
  inputs: ["list the files"],
  model: () => ({ error: { status: 400, type: "invalid_request_error", message: "bad request" } }),
  errors: ["pi_agent_error"],
};

const errors = (outcome: Outcome) => outcome.log.filter((event) => event.type === "session.error");

describe("crash injection: a request that fails and is retried", async () => {
  await sweep(retried, (outcome) => expect(errors(outcome)).toEqual([]));
});

describe("crash injection: a request that keeps failing", async () => {
  await sweep(failing, (outcome) => expect(errors(outcome)).toHaveLength(1));
});
