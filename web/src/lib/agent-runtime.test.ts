import { describe, it, expect } from "vitest";
import { LOCKED_RUNTIME, DEFAULT_MODEL, PI_MODELS } from "./agent-runtime";

describe("Pi Agent models", () => {
  it("uses Pi with the local default model", () => {
    expect(LOCKED_RUNTIME).toBe("pi-agent");
    expect(DEFAULT_MODEL).toBe("openai-codex/gpt-5.6-sol");
  });

  it("offers the three configured provider/model selections", () => {
    expect(PI_MODELS).toEqual([
      { value: "kimi-coding-plan/k3", label: "K3" },
      { value: "openai-codex/gpt-6-astra", label: "GPT-6 Astra" },
      { value: "openai-codex/gpt-5.6-sol", label: "GPT-5.6 Sol" },
    ]);
  });
});
