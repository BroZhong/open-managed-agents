import { readFileSync } from "node:fs";
import { describe, expect, it, vi, afterEach } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import { thinkingOptions, customThinkingOptions, customModelThinkingOptions } from "../src/thinking-options.js";
import { capabilityReferences } from "../src/custom-capabilities.js";
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
      models: [{ id: "acme/model", name: "Test", reasoning: false, reasoningSource: "upstream", capabilityVersion: 1, input: ["text"], contextWindow: 32768, maxTokens: 1024 }],
    });
    expect(options.choices).toEqual([{ value: "off", label: "off" }]);
    expect(options.resolvedLevels.max).toBe("off");
    expect(JSON.stringify(options)).not.toContain("private.example.com");
    expect(request).not.toHaveBeenCalled();
  });
  it.each([undefined, false, true])("uses Pi basic thinking for an unknown model with legacy reasoning=%s", async (reasoning) => {
    const options = await customThinkingOptions("custom-test/unknown", {
      id: "custom-test", name: "Private", api: "openai-completions", baseUrl: "https://private.example.com/v1",
      models: [{ id: "unknown", name: "Test", reasoning, input: ["text"], contextWindow: 32768, maxTokens: 4096 }],
    });
    expect(options.choices.map(choice => choice.value)).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(options.defaultLevel).toBe("high");
    expect(options.resolvedLevels.max).toBe("high");
    expect(options).toMatchObject({ control: "app", source: "default" });
  });
  it("uses an explicit same-protocol reference before upstream declarations while retaining the upstream id", () => {
    const options = customModelThinkingOptions("anthropic-messages", {
      id: "routing/private-opus", name: "Private", reasoning: false, reasoningSource: "upstream",
      capabilityReference: { provider: "anthropic", modelId: "claude-opus-4-7" },
      input: ["text"], contextWindow: 32768, maxTokens: 4096,
    });
    expect(options.model).toBe("custom-preview/routing/private-opus");
    expect(options.defaultLevel).toBe("max");
    expect(options.choices.map(choice => choice.value)).toContain("xhigh");
    expect(options).toMatchObject({ source: "manual", reference: { provider: "anthropic", modelId: "claude-opus-4-7" } });
  });
  it("automatically uses unambiguous protocol matches, preserves explicit upstream rejection and only recommends aliases", () => {
    const definition = { id: "Ring-2.6-1T", name: "Ring", input: ["text"] as ("text" | "image")[], contextWindow: 32768, maxTokens: 4096 };
    const exact = customModelThinkingOptions("openai-completions", definition);
    expect(exact.choices.map(choice => choice.value)).toEqual(["high", "xhigh"]);
    expect(exact).toMatchObject({ source: "catalog", reference: { provider: "ant-ling", modelId: "Ring-2.6-1T" } });
    const rejected = customModelThinkingOptions("openai-completions", { ...definition, reasoning: false, reasoningSource: "upstream" });
    expect(rejected.choices.map(choice => choice.value)).toEqual(["off"]);
    expect(rejected.source).toBe("upstream");
    const alias = customModelThinkingOptions("openai-completions", { ...definition, id: "route/Ring-2.6-1T" });
    expect(alias.defaultLevel).toBe("high");
    expect(alias.reference).toBeUndefined();
    expect(alias.recommendations).toContainEqual({ provider: "ant-ling", modelId: "Ring-2.6-1T", name: expect.any(String), reason: "Model ID matches after removing a route prefix or normalizing punctuation." });
    const unsupported = customModelThinkingOptions("openai-responses", { ...definition, id: "gpt-4.1", reasoning: true });
    expect(unsupported.choices.map(choice => choice.value)).toEqual(["off"]);
    expect(unsupported.source).toBe("catalog");
  });
  it("does not choose among ambiguous exact catalog providers", () => {
    const options = customModelThinkingOptions("anthropic-messages", { id: "claude-opus-4-7", name: "Private", input: ["text"], contextWindow: 32768, maxTokens: 4096 });
    expect(options.defaultLevel).toBe("high");
    expect(options.reference).toBeUndefined();
    expect(options.recommendations!.length).toBeGreaterThan(1);
    expect(options.recommendations).toContainEqual(expect.objectContaining({ provider: "anthropic", modelId: "claude-opus-4-7" }));
  });
  it("fails visibly for unavailable or cross-protocol references and unsupported provider control", () => {
    const definition = { id: "private", name: "Private", input: ["text"] as ("text" | "image")[], contextWindow: 32768, maxTokens: 4096 };
    expect(() => customModelThinkingOptions("openai-completions", { ...definition, capabilityReference: { provider: "anthropic", modelId: "claude-opus-4-7" } })).toThrow("unavailable for openai-completions");
    expect(() => customModelThinkingOptions("anthropic-messages", { ...definition, capabilityReference: { provider: "anthropic", modelId: "no-longer-present" } })).toThrow("Clear or replace");
    expect(() => customModelThinkingOptions("anthropic-messages", { ...definition, thinkingMode: "provider" })).toThrow("Provider-controlled thinking is unavailable");
  });
  it("retains legacy catalog references and clearing them returns to automatic resolution", () => {
    const definition = { id: "claude-opus-4-7", name: "Private", reasoning: false, input: ["text"] as ("text" | "image")[], contextWindow: 32768, maxTokens: 4096 };
    expect(customModelThinkingOptions("anthropic-messages", { ...definition, catalogProvider: "anthropic" }).defaultLevel).toBe("max");
    expect(customModelThinkingOptions("anthropic-messages", definition).defaultLevel).toBe("high");
  });
  it("exposes only credential-free same-protocol catalog identities and recommendations", () => {
    const catalog = capabilityReferences("anthropic-messages", "route/claude-opus-4-7");
    expect(catalog.data).toContainEqual({ provider: "anthropic", modelId: "claude-opus-4-7", name: "Claude Opus 4.7", reasoning: true });
    expect(catalog.data.some(entry => entry.modelId === "gpt-5.6-sol")).toBe(false);
    for (const entry of catalog.data) expect(Object.keys(entry).sort()).toEqual(["modelId", "name", "provider", "reasoning"]);
    expect(catalog.recommendations).toContainEqual(expect.objectContaining({ provider: "anthropic", modelId: "claude-opus-4-7" }));
  });
});
