import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { DEFAULT_MODEL, highestThinkingLevel, resolveModel } from "../src/model-resolver.js";

let runtime: ModelRuntime;

beforeAll(async () => {
  runtime = await ModelRuntime.create({
    modelsPath: fileURLToPath(new URL("../../../../deploy/pi-models.json", import.meta.url)),
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
  });
});

describe("configured Pi models", () => {
  it("loads the deploy catalog without config errors", () => {
    expect(runtime.getError()).toBeUndefined();
  });

  it.each([
    ["K3", "kimi-coding-plan", "k3", "xhigh"],
    ["gpt-6-astra", "openai-codex", "gpt-6-astra", "max"],
    ["gpt-5.6-sol", "openai-codex", "gpt-5.6-sol", "max"],
  ])("resolves %s and selects its highest thinking level", (selection, provider, id, thinking) => {
    const model = resolveModel(selection, runtime);
    expect(model).toMatchObject({ provider, id, reasoning: true });
    expect(resolveModel(`${provider}/${id}`, runtime)).toEqual(model);
    expect(highestThinkingLevel(model)).toBe(thinking);
    expect(model.thinkingLevelMap?.[thinking as keyof typeof model.thinkingLevelMap]).toBe("max");
  });

  it("preserves the local K3 endpoint and provider-specific compatibility", () => {
    expect(resolveModel("K3", runtime)).toMatchObject({
      baseUrl: "https://api.kimi.com/coding/v1",
      api: "openai-completions",
      compat: {
        supportsDeveloperRole: false,
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: "openai",
      },
    });
  });

  it("uses the local default only for absent/default selections", () => {
    for (const selection of [undefined, "", "default"]) {
      expect(resolveModel(selection, runtime)).toMatchObject(DEFAULT_MODEL);
    }
  });

  it("rejects unavailable selections without silently changing models", () => {
    expect(() => resolveModel("openai-codex/unconfigured-model", runtime))
      .toThrow("Pi model openai-codex/unconfigured-model is not configured");
  });

  it("disables thinking for a model without reasoning", () => {
    expect(highestThinkingLevel({ ...resolveModel("K3", runtime), reasoning: false })).toBe("off");
  });
});
