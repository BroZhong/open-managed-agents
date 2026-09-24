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
    ).rejects.toThrow("Check the protocol");
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
