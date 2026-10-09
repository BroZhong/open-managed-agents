import { readFileSync } from "node:fs";
import { describe, expect, it, vi, afterEach } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import { thinkingOptions, customThinkingOptions } from "../src/thinking-options.js";
const config = JSON.parse(readFileSync(new URL("../../../../deploy/pi-models.json", import.meta.url), "utf8"));
function model(provider: string, id: string): Model<Api> {
  const p = config.providers[provider];
  return { ...p.models.find((m: { id: string }) => m.id === id), provider, api: p.api, baseUrl: p.baseUrl };
}
afterEach(() => vi.unstubAllGlobals());
describe("Pi thinking options for display", () => {
  it("shows Astra's five distinct efforts and maps legacy aliases and unsupported off", () => {
    const options = thinkingOptions(model("openai-codex", "gpt-6-astra"));
    expect(options.choices.map(c => c.value)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(options.resolvedLevels.minimal).toBe("low");
    expect(options.resolvedLevels.off).toBe("low");
    expect(options.defaultLevel).toBe("max");
    expect(Object.keys(options).sort()).toEqual(["choices", "defaultLevel", "model", "resolvedLevels"]);
  });
  it("collapses GLM effort aliases without offering unsupported Pi max", () => {
    const options = thinkingOptions(model("bigmodel", "glm-5.3"));
    expect(options.choices).toEqual([{ value: "low", label: "low" }, { value: "high", label: "high" }, { value: "xhigh", label: "max" }]);
    expect(options.resolvedLevels.medium).toBe("high");
    expect(options.resolvedLevels.max).toBe("xhigh");
  });
  it("keeps a real off option when the model supports it", () => {
    expect(thinkingOptions(model("openai-codex", "gpt-5.6-sol")).choices[0]).toEqual({ value: "off", label: "off" });
  });
  it("reads custom non-reasoning metadata without credentials or network", async () => {
    const request = vi.fn(() => { throw new Error("Unexpected network request"); });
    vi.stubGlobal("fetch", request);
    const options = await customThinkingOptions("custom-test/acme/model", {
      id: "custom-test", name: "Private", api: "openai-completions", baseUrl: "https://private.example.com/v1",
      models: [{ id: "acme/model", name: "Test", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 1024 }],
    });
    expect(options.choices).toEqual([{ value: "off", label: "off" }]);
    expect(options.resolvedLevels.max).toBe("off");
    expect(JSON.stringify(options)).not.toContain("private.example.com");
    expect(request).not.toHaveBeenCalled();
  });
});
