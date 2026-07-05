import { describe, it, expect } from "vitest";
import { LOCKED_RUNTIME, LOCKED_MODEL, LOCKED_MODEL_LABEL } from "./agent-runtime";

describe("agent-runtime lock (issue #69)", () => {
  it("locks the runtime to pi-agent", () => {
    expect(LOCKED_RUNTIME).toBe("pi-agent");
  });

  it("locks the model to openai-codex/gpt-5.5", () => {
    expect(LOCKED_MODEL).toBe("openai-codex/gpt-5.5");
  });

  it("has a human-readable label for the locked model", () => {
    expect(LOCKED_MODEL_LABEL).toBeTruthy();
  });
});
