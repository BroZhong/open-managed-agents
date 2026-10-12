import { describe, expect, it, vi } from "vitest";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  registerCustomProvider,
  testCustomProvider,
  type CustomProviderDefinition,
} from "../src/custom-provider.js";
const definition: CustomProviderDefinition = {
  id: "custom-isolated",
  name: "Gateway",
  api: "openai-completions",
  baseUrl: "https://models.example.com/v1",
  apiKey: "!literal-key",
  models: [
    {
      id: "acme/model",
      name: "Acme",
      contextWindow: 32768,
      maxTokens: 4096,
      reasoning: false,
      input: ["text"],
    },
  ],
};
function completion() {
  return new Response(
    `data: ${JSON.stringify({ id: "chat-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "chat-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
async function runtime() {
  return ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
}
describe("Pi custom providers", () => {
  it("uses Pi's actual streaming implementation for connection tests", async () => {
    const request = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe(
        "https://models.example.com/v1/chat/completions",
      );
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer !literal-key",
      );
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "acme/model",
        stream: true,
      });
      return completion();
    });
    await testCustomProvider(definition, request);
    expect(request).toHaveBeenCalledOnce();
  });
  it("isolates identical provider ids and literal credentials across concurrent runtimes", async () => {
    const [one, two] = await Promise.all([runtime(), runtime()]);
    const first = vi.fn<typeof fetch>(async () => completion());
    const second = vi.fn<typeof fetch>(async () => completion());
    await Promise.all([
      registerCustomProvider(one, definition, first),
      registerCustomProvider(
        two,
        {
          ...definition,
          apiKey: "other-key",
          baseUrl: "https://other.example.com/v1",
        },
        second,
      ),
    ]);
    expect((await one.getAuth(definition.id))?.auth.apiKey).toBe(
      "!literal-key",
    );
    expect((await two.getAuth(definition.id))?.auth.apiKey).toBe("other-key");
    expect(one.getModel(definition.id, "acme/model")?.baseUrl).toBe(
      definition.baseUrl,
    );
    const model = one.getModel(definition.id, "acme/model")!;
    const result = await one.completeSimple(model, {
      messages: [{ role: "user", content: "Hi", timestamp: 0 }],
    });
    expect(result.stopReason).toBe("stop");
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
  });
  it("treats HTTP success with an empty stream as failed inference", async () => {
    await expect(
      testCustomProvider(
        definition,
        async () =>
          new Response("data: [DONE]\n\n", {
            headers: { "Content-Type": "text/event-stream" },
          }),
      ),
    ).rejects.toThrow("did not complete");
  });
  it("never exposes upstream response bodies containing secrets", async () => {
    await expect(
      testCustomProvider(definition, async () =>
        Response.json({ error: { message: "!literal-key" } }, { status: 401 }),
      ),
    ).rejects.toThrow("HTTP 401");
  });
  it.each([400, 401, 429])("sanitizes custom provider HTTP %s in runtime events and result without retrying a thinking fallback", async status => {
    const current = await runtime();
    const requests: Record<string, unknown>[] = [];
    await registerCustomProvider(current, definition, async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ error: { message: "Unsupported reasoning_effort; key=!literal-key" } }, { status });
    });
    const model = current.getModel(definition.id, "acme/model")!;
    const stream = current.streamSimple(model, { messages: [{ role: "user", content: "Hi", timestamp: 0 }] }, { reasoning: "high", maxRetries: 0 });
    const events = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(JSON.stringify([result, events])).not.toContain("!literal-key");
    expect(result.errorMessage).toContain(status === 400 ? "rejected a thinking control parameter" : `HTTP ${status}`);
    expect(requests).toHaveLength(1);
    expect(requests[0].reasoning_effort).toBe("high");
  });
  it.each(["invalid_api_key", "rate_limit_error"])("does not mislabel HTTP 400 %s as a thinking rejection", async type => {
    const current = await runtime();
    await registerCustomProvider(current, definition, async () => Response.json(
      { error: { type, message: "Unsupported reasoning_effort; key=!literal-key" } }, { status: 400 },
    ));
    const result = await current.completeSimple(current.getModel(definition.id, "acme/model")!, { messages: [{ role: "user", content: "Hi", timestamp: 0 }] });
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).not.toContain("rejected a thinking control parameter");
    expect(result.errorMessage).not.toContain("!literal-key");
  });
  it("retains partial text without exposing a later stream error through earlier event objects", async () => {
    const current = await runtime();
    await registerCustomProvider(current, definition, async () => new Response(
      'data: {"choices":[{"index":0,"delta":{"content":"Partial answer"},"finish_reason":null}]}\n\ndata: {"error":{"message":"stream failed key=!literal-key"}}\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    ));
    const stream = current.streamSimple(current.getModel(definition.id, "acme/model")!, { messages: [{ role: "user", content: "Hi", timestamp: 0 }] });
    const events = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(JSON.stringify([result, events])).not.toContain("!literal-key");
    expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "Partial answer" }));
  });
  it.each([
    ["invalid_request_error", "Unsupported parameter: thinking.budget_tokens", true],
    ["authentication_error", "Unsupported parameter: thinking.budget_tokens; invalid API key", false],
    ["rate_limit_error", "Unsupported parameter: thinking.budget_tokens; quota reached", false],
    ["invalid_request_error", "Invalid API key for thinking request", false],
    ["invalid_request_error", "Invalid max_output_tokens", false],
  ] as const)("classifies HTTP 200 Anthropic SSE %s safely: %s", async (type, message, thinkingRejected) => {
    const current = await runtime();
    const request = vi.fn<typeof fetch>(async () => new Response(
      `event: error\ndata: ${JSON.stringify({ type: "error", error: { type, message: `${message}; key=!literal-key` } })}\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    ));
    await registerCustomProvider(current, { ...definition, api: "anthropic-messages" }, request);
    const stream = current.streamSimple(current.getModel(definition.id, "acme/model")!, { messages: [{ role: "user", content: "Hi", timestamp: 0 }] }, { reasoning: "high", maxRetries: 0 });
    const events = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage?.includes("rejected a thinking control parameter")).toBe(thinkingRejected);
    expect(JSON.stringify([result, events])).not.toContain("!literal-key");
    expect(request).toHaveBeenCalledOnce();
  });
  it.each(["openai-responses", "anthropic-messages"] as const)(
    "uses native Pi %s requests and SSE parsing",
    async (api) => {
      const message = {
        id: "msg_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "OK", annotations: [] }],
      };
      const events =
        api === "openai-responses"
          ? [
              { type: "response.created", response: { id: "resp_1" } },
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { ...message, content: [] },
              },
              {
                type: "response.output_text.delta",
                output_index: 0,
                content_index: 0,
                delta: "OK",
              },
              {
                type: "response.output_item.done",
                output_index: 0,
                item: message,
              },
              {
                type: "response.completed",
                response: {
                  id: "resp_1",
                  status: "completed",
                  output: [message],
                  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                },
              },
            ]
          : [
              {
                type: "message_start",
                message: {
                  id: "msg_1",
                  type: "message",
                  role: "assistant",
                  content: [],
                  model: "acme/model",
                  usage: { input_tokens: 1, output_tokens: 0 },
                },
              },
              {
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "" },
              },
              {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: "OK" },
              },
              { type: "content_block_stop", index: 0 },
              {
                type: "message_delta",
                delta: { stop_reason: "end_turn" },
                usage: { output_tokens: 1 },
              },
              { type: "message_stop" },
            ];
      const request = vi.fn<typeof fetch>(async (url, init) => {
        expect(String(url)).toBe(
          api === "openai-responses"
            ? "https://models.example.com/v1/responses"
            : "https://models.example.com/v1/messages",
        );
        const headers = new Headers(init?.headers);
        expect(
          headers.get(
            api === "openai-responses" ? "authorization" : "x-api-key",
          ),
        ).toBe(
          api === "openai-responses" ? "Bearer !literal-key" : "!literal-key",
        );
        expect(JSON.parse(String(init?.body)).model).toBe("acme/model");
        return new Response(
          events
            .map(
              (event) =>
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
            .join(""),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      });
      await testCustomProvider(
        {
          ...definition,
          api,
          baseUrl:
            api === "anthropic-messages"
              ? "https://models.example.com"
              : definition.baseUrl,
        },
        request,
      );
      expect(request).toHaveBeenCalledOnce();
    },
  );
});
