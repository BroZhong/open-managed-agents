import { describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerCustomProvider } from "../src/custom-provider.js";
import { resolveModel } from "../src/model-resolver.js";
import { buildCustomTools } from "../src/custom-tools.js";
import { buildSubagentTools } from "../src/managed-subagents.js";
import { ProtocolExecutor } from "./sandbox-protocol-fixture.js";

const tools = [
  ...buildCustomTools(new ProtocolExecutor()),
  ...buildSubagentTools({ maxModelSteps: 500, delegate: vi.fn(), getResult: vi.fn(), steer: vi.fn() }),
  // Extension tools enter the same SDK context; keep nested optional arguments too.
  { name: "extension_lookup", description: "Look up remote data", parameters: Type.Object({
    query: Type.String(), options: Type.Optional(Type.Object({ limit: Type.Optional(Type.Number()) })),
  }) },
];

function completedResponse() {
  const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "Agent", arguments: '{"prompt":"Reply OK"}', status: "completed" };
  const events = [
    { type: "response.created", response: { id: "resp_1" } },
    { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: call.arguments },
    { type: "response.output_item.done", output_index: 0, item: call },
    { type: "response.completed", response: { id: "resp_1", status: "completed", output: [call], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}

describe("Responses SDK wire tool schemas", () => {
  it.each(["custom provider", "configured model"])("preserves optional arguments for every function tool through %s", async route => {
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false });
    const requests: Array<{ tools: Array<{ name: string; strict?: boolean; parameters: unknown }> }> = [];
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return completedResponse();
    });
    await registerCustomProvider(runtime, {
      id: "custom-test", name: "Test", api: "openai-responses", baseUrl: "https://models.example.com/v1", apiKey: "test-key",
      models: [{ id: "unknown-sol", name: "Sol", contextWindow: 32000, maxTokens: 4096, reasoning: true, input: ["text"] }],
    }, request);
    const registered = runtime.getModel("custom-test", "unknown-sol")!;
    // Host models.json may carry older compatibility flags. Exercise resolution,
    // then the real SDK stream, not convertResponsesTools in isolation.
    const model = route === "custom provider" ? registered : resolveModel("custom-test/unknown-sol", {
      getModel: () => ({ ...registered, compat: { supportsStrictMode: false, supportsTemperature: false } }),
    });
    const result = await runtime.completeSimple(model, { messages: [{ role: "user", content: "Delegate a task", timestamp: 0 }], tools }, { maxRetries: 0 });
    expect(request).toHaveBeenCalledOnce();
    expect(requests[0].tools).toHaveLength(tools.length);
    for (const tool of tools) {
      expect(requests[0].tools.find(item => item.name === tool.name), tool.name).toEqual(expect.objectContaining({
        strict: false, parameters: JSON.parse(JSON.stringify(tool.parameters)),
      }));
    }
    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toContainEqual(expect.objectContaining({ type: "toolCall", name: "Agent", arguments: { prompt: "Reply OK" } }));
    if (route === "configured model") expect(model.compat).toMatchObject({ supportsTemperature: false });
  });
});
