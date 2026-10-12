import { describe, expect, it } from "vitest";
import { createModels, InMemoryCredentialStore, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createCustomProvider, testCustomProvider, type CustomModelDefinition, type CustomProviderProtocol } from "../src/custom-provider.js";
import { customModelThinkingOptions } from "../src/thinking-options.js";

const definition: CustomModelDefinition = { id: "route/unknown", name: "Private", contextWindow: 131072, maxTokens: 32768, input: ["text"] };

function reply(api: CustomProviderProtocol): Response {
  let events: Record<string, any>[];
  if (api === "openai-completions") {
    return new Response('data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
  }
  if (api === "openai-responses") {
    const message = { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] };
    events = [
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "OK" },
      { type: "response.output_item.done", output_index: 0, item: message },
      { type: "response.completed", response: { id: "resp_1", status: "completed", output: [message], usage: { input_tokens: 1, output_tokens: 1 } } },
    ];
  } else {
    events = [
      { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], model: definition.id, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
  }
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}

async function controlled(api: CustomProviderProtocol, model = definition) {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("custom-test", async () => ({ type: "api_key", key: "tenant-key" }));
  const models = createModels({ credentials });
  const requests: { url: string; body: Record<string, any>; headers: Headers }[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return reply(api);
  };
  const provider = { id: "custom-test", name: "Private", api, baseUrl: "https://tenant.example.com/v1", apiKey: "tenant-key", models: [model] };
  models.setProvider(createCustomProvider(provider, fetch));
  return { models, model: models.getModels("custom-test")[0], requests, provider, fetch };
}

describe("custom thinking through unmodified Pi requests", () => {
  it("applies a configured five-level Adaptive profile to an upstream Opus alias", async () => {
    const configured = { ...definition, id: "global.anthropic.claude-opus-5-5", thinkingProfile: "anthropic-adaptive" as const };
    const options = customModelThinkingOptions("anthropic-messages", configured);
    expect(options.choices.map(choice => choice.value)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(options.defaultLevel).toBe("max");
    expect(options.resolvedLevels).toMatchObject({ off: "low", minimal: "low", high: "high", xhigh: "xhigh", max: "max" });
    const { models, model, requests } = await controlled("anthropic-messages", configured);
    for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
      expect((await models.completeSimple(model, { messages: [{ role: "user", content: "Reply OK", timestamp: 0 }] }, { reasoning: level })).stopReason).toBe("stop");
    }
    expect(requests.map(request => request.body.output_config?.effort)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    for (const { body } of requests) {
      expect(body.model).toBe("global.anthropic.claude-opus-5-5");
      expect(body.thinking).toMatchObject({ type: "adaptive" });
      expect(body.thinking).not.toHaveProperty("budget_tokens");
    }
  });
  it.each(["openai-completions", "openai-responses", "anthropic-messages"] as const)("serializes all five basic levels for an unknown %s model", async api => {
    const { models, model, requests } = await controlled(api);
    for (const level of ["off", "minimal", "low", "medium", "high"] as const) {
      const result = await models.completeSimple(model, { messages: [{ role: "user", content: "Hi", timestamp: 0 }] }, { reasoning: level === "off" ? undefined : level, maxTokens: 1024 });
      expect(result.stopReason).toBe("stop");
    }
    expect(requests.map(request => request.body.model)).toEqual(Array(5).fill("route/unknown"));
    if (api === "openai-completions") {
      expect(requests.map(request => request.body.reasoning_effort)).toEqual([undefined, "minimal", "low", "medium", "high"]);
    } else if (api === "openai-responses") {
      expect(requests.map(request => request.body.reasoning.effort)).toEqual(["none", "minimal", "low", "medium", "high"]);
      expect(requests[4].body.include).toEqual(["reasoning.encrypted_content"]);
    } else {
      expect(requests.map(request => request.body.thinking)).toMatchObject([
        { type: "disabled" },
        { type: "enabled", budget_tokens: 1024 },
        { type: "enabled", budget_tokens: 2048 },
        { type: "enabled", budget_tokens: 8192 },
        { type: "enabled", budget_tokens: 16384 },
      ]);
    }
  });

  it.each([
    ["openai-responses", "openai", "gpt-5.6-sol", "max"],
    ["anthropic-messages", "anthropic", "claude-opus-4-7", "max"],
    ["anthropic-messages", "anthropic", "claude-sonnet-4-5", "high"],
    ["openai-completions", "deepseek", "deepseek-v4-flash", "max"],
  ] as const)("uses %s reference %s/%s while preserving actual tenant identity", async (api, provider, modelId, level) => {
    const configured = { ...definition, capabilityReference: { provider, modelId } };
    const { models, model, requests } = await controlled(api, configured);
    expect(customModelThinkingOptions(api, configured).defaultLevel).toBe(level);
    const result = await models.completeSimple(model, { messages: [{ role: "user", content: "Hi", timestamp: 0 }] }, { reasoning: level as Exclude<ModelThinkingLevel, "off">, maxTokens: 1024 });
    expect(result.stopReason).toBe("stop");
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request.url.startsWith("https://tenant.example.com/v1/")).toBe(true);
    expect(request.body.model).toBe("route/unknown");
    expect(request.headers.get(api === "anthropic-messages" ? "x-api-key" : "authorization")).toBe(api === "anthropic-messages" ? "tenant-key" : "Bearer tenant-key");
    if (api === "openai-responses") expect(request.body.reasoning.effort).toBe("max");
    else if (api === "openai-completions") {
      expect(request.body.thinking).toEqual({ type: "enabled" });
      expect(request.body.reasoning_effort).toBe("max");
    } else if (modelId === "claude-opus-4-7") {
      expect(request.body.thinking).toMatchObject({ type: "adaptive" });
      expect(request.body.output_config).toMatchObject({ effort: "max" });
    } else expect(request.body.thinking).toMatchObject({ type: "enabled", budget_tokens: 16384 });
  });

  it("tests the default highest level without certifying effort execution", async () => {
    const { provider, fetch, requests } = await controlled("openai-completions");
    await testCustomProvider(provider, fetch);
    expect(requests).toHaveLength(1);
    expect(requests[0].body.reasoning_effort).toBe("high");
  });
  it.each([
    [{ ...definition, capabilityReference: { provider: "openai", modelId: "gpt-4.1" } }, 0],
    [{ ...definition, id: "gpt-4.1" }, 0],
    [{ ...definition, id: "gpt-4.1", catalogProvider: "openai" }, 0.00001],
    [{ ...definition, id: "gpt-4.1", catalogProvider: "openai", capabilityReference: { provider: "openai", modelId: "gpt-4.1" } }, 0],
  ] as const)("keeps capability references separate from tenant pricing (definition %j)", async (configured, expectedCost) => {
    const { models, model } = await controlled("openai-responses", configured);
    const result = await models.completeSimple(model, { messages: [{ role: "user", content: "Hi", timestamp: 0 }] });
    expect(result.stopReason).toBe("stop");
    expect(result.usage.input).toBe(1);
    expect(result.usage.output).toBe(1);
    expect(result.usage.cost.total).toBeCloseTo(expectedCost, 10);
  });
});
