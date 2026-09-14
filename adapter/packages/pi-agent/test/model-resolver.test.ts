import { beforeAll, describe, expect, it, vi } from "vitest";
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

describe("K3 catalog compatibility", () => {
  it.each(["K3", "kimi-coding-plan/k3"])(
    "resolves %s to the configured upstream model when k3 is absent",
    (selection) => {
      const upstream = { ...resolveModel("K3", runtime), id: "kimi-k3" };
      const getModel = vi.fn((provider: string, id: string) =>
        provider === "kimi-coding-plan" && id === "kimi-k3" ? upstream : undefined,
      );

      expect(resolveModel(selection, { getModel })).toBe(upstream);
      expect(getModel.mock.calls).toEqual([
        ["kimi-coding-plan", "k3"],
        ["kimi-coding-plan", "kimi-k3"],
      ]);
    },
  );

  it("prefers the exact k3 model when both model ids are configured", () => {
    const exact = resolveModel("K3", runtime);
    const upstream = { ...exact, id: "kimi-k3" };
    const getModel = vi.fn((provider: string, id: string) => {
      if (provider !== "kimi-coding-plan") return undefined;
      return id === "k3" ? exact : id === "kimi-k3" ? upstream : undefined;
    });

    expect(resolveModel("kimi-coding-plan/k3", { getModel })).toBe(exact);
    expect(getModel.mock.calls).toEqual([["kimi-coding-plan", "k3"]]);
  });

  it("reports the requested model when neither K3 model is configured", () => {
    const getModel = vi.fn(() => undefined);

    expect(() => resolveModel("kimi-coding-plan/k3", { getModel }))
      .toThrow("Pi model kimi-coding-plan/k3 is not configured; add it to the Host Pi models.json");
  });

  it.each([
    ["openai", "k3"],
    ["kimi-coding-plan", "unconfigured-model"],
  ])("does not apply the K3 fallback to %s/%s", (provider, id) => {
    const upstream = { ...resolveModel("K3", runtime), id: "kimi-k3" };
    const getModel = vi.fn((candidateProvider: string, candidateId: string) =>
      candidateProvider === "kimi-coding-plan" && candidateId === "kimi-k3" ? upstream : undefined,
    );

    expect(() => resolveModel(`${provider}/${id}`, { getModel }))
      .toThrow(`Pi model ${provider}/${id} is not configured`);
    expect(getModel.mock.calls).toEqual([[provider, id]]);
  });
});
