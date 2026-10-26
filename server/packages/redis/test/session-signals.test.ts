import { describe, expect, it } from "vitest";
import { sessionSignalScope } from "../src/session-signals.js";

describe("sessionSignalScope", () => {
  it("puts what Runners act on on the control channel and what APIs relay on the output channel", () => {
    expect((["wake", "check", "sandbox"] as const).map(sessionSignalScope)).toEqual(["control", "control", "control"]);
    expect((["durable", "chunk"] as const).map(sessionSignalScope)).toEqual(["output", "output"]);
  });
});
