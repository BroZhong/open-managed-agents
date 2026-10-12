import { describe, expect, it } from "vitest";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { stream as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { stream as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as anthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { Type } from "typebox";

const model: Model<Api> = {
  id: "tenant-alias", provider: "custom-boundary", name: "Boundary",
  api: "openai-responses", baseUrl: "https://gateway.example.com/v1",
  reasoning: true, input: ["text"], contextWindow: 32768, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const history: AssistantMessage = {
  role: "assistant", api: model.api, provider: model.provider, model: model.id,
  content: [{ type: "toolCall", id: "call_1", name: "lookup", arguments: {} }],
  stopReason: "toolUse", timestamp: 0,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};
function context(api: Api, assistant: AssistantMessage = history): Context {
  return {
    systemPrompt: "Keep this instruction.",
    tools: [{ name: "lookup", description: "Look up an answer", parameters: Type.Object({}) }],
    messages: [{ role: "user", content: "Look up the answer.", timestamp: 0 },
      { ...assistant, api },
      { role: "toolResult", toolCallId: "call_1", toolName: "lookup", content: [{ type: "text", text: "42" }], isError: false, timestamp: 0 }],
  };
}
const sse = (events: Record<string, unknown>[]) => new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });

describe("Pi 0.83 public provider-control feasibility", () => {
  it("Responses full stream omission loses encrypted content needed for fresh reasoning replay", async () => {
    const requests: Record<string, any>[] = [];
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      const item = { type: "reasoning", id: "rs_fresh", summary: [{ type: "summary_text", text: "Fresh thought" }],
        ...(body.include?.includes("reasoning.encrypted_content") ? { encrypted_content: "opaque-fresh" } : {}) };
      return sse([
        { type: "response.created", response: { id: "resp_1" } },
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "resp_1", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1 } } },
      ]);
    };
    const active = { ...model, api: "openai-responses" as const };
    const controlled = await responses(active, context(active.api), { apiKey: "test", fetch, reasoningEffort: "high" }).result();
    expect(controlled.stopReason).toBe("stop");
    expect(requests[0].include).toEqual(["reasoning.encrypted_content"]);
    expect(controlled.content[0]).toMatchObject({ type: "thinking", thinkingSignature: expect.stringContaining("opaque-fresh") });
    const omit = { ...active, thinkingLevelMap: { off: null } };
    const delegated = await responses(omit, context(active.api), { apiKey: "test", fetch }).result();
    expect(requests[1]).not.toHaveProperty("reasoning");
    expect(requests[1]).not.toHaveProperty("include");
    expect(requests[1].input[0].role).toBe("developer");
    expect(requests[1].input).toContainEqual(expect.objectContaining({ type: "function_call_output", output: "42" }));
    expect(JSON.stringify(delegated)).not.toContain("opaque-fresh");
    await responses(omit, { messages: [delegated, { role: "user", content: "Continue", timestamp: 0 }] }, { apiKey: "test", fetch }).result();
    expect(JSON.stringify(requests[2].input)).not.toContain("opaque-fresh");
    await responses({ ...active, reasoning: false }, context(active.api), { apiKey: "test", fetch }).result();
    expect(requests[3].input[0].role).toBe("system");

    // Test-only boundary proposal. Production does not own provider payload
    // fields; adopting this hook requires an explicit ADR-0014 boundary change.
    const omitControls = (payload: unknown) => {
      const request = { ...(payload as Record<string, unknown>) };
      delete request.reasoning;
      return request;
    };
    const previous = { ...controlled, content: [...controlled.content, ...history.content] };
    const proposed = await responses(active, context(active.api, previous), { apiKey: "test", fetch, reasoningEffort: "high", onPayload: omitControls }).result();
    expect(requests[4]).not.toHaveProperty("reasoning");
    expect(requests[4].include).toEqual(["reasoning.encrypted_content"]);
    expect(requests[4].input[0].role).toBe("developer");
    expect(requests[4].input).toContainEqual(expect.objectContaining({ type: "reasoning", encrypted_content: "opaque-fresh" }));
    expect(requests[4].input).toContainEqual(expect.objectContaining({ type: "function_call_output", output: "42" }));
    expect(proposed.content[0]).toMatchObject({ type: "thinking", thinkingSignature: expect.stringContaining("opaque-fresh") });
    await responses(active, context(active.api, { ...proposed, content: [...proposed.content, ...history.content] }), { apiKey: "test", fetch, reasoningEffort: "high", onPayload: omitControls }).result();
    expect(requests[5].input).toContainEqual(expect.objectContaining({ type: "reasoning", encrypted_content: "opaque-fresh" }));
  });

  it("Chat reasoning=false omits controls but changes developer role and required empty tool reasoning", async () => {
    const requests: Record<string, any>[] = [];
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
    };
    const active = { ...model, api: "openai-completions" as const, compat: { thinkingFormat: "deepseek" as const, supportsDeveloperRole: true, requiresReasoningContentOnAssistantMessages: true } };
    await completions(active, context(active.api), { apiKey: "test", fetch, reasoningEffort: "high" }).result();
    await completions({ ...active, reasoning: false }, context(active.api), { apiKey: "test", fetch }).result();
    expect(requests[0].messages[0].role).toBe("developer");
    expect(requests[0].messages.find((m: any) => m.role === "assistant")).toHaveProperty("reasoning_content", "");
    expect(requests[1]).not.toHaveProperty("thinking");
    expect(requests[1]).not.toHaveProperty("reasoning_effort");
    expect(requests[1].messages[0].role).toBe("system");
    expect(requests[1].messages.find((m: any) => m.role === "assistant")).not.toHaveProperty("reasoning_content");
    expect(requests[1].messages.at(-1)).toMatchObject({ role: "tool", content: "42" });
  });

  it("Anthropic full stream can omit controls while retaining signed thinking and tool history", async () => {
    let body: Record<string, any> = {};
    const active = { ...model, api: "anthropic-messages" as const, compat: undefined };
    const signed: AssistantMessage = { ...history, api: active.api, content: [
      { type: "thinking", thinking: "Existing thought", thinkingSignature: "signed-thought" }, ...history.content,
    ] };
    const result = await anthropic(active, context(active.api, signed), { apiKey: "test", fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return sse([
        { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: active.id, content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]);
    } }).result();
    expect(result.stopReason).toBe("stop");
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("output_config");
    expect(body.messages[1].content).toContainEqual({ type: "thinking", thinking: "Existing thought", signature: "signed-thought" });
    expect(body.messages.at(-1).content[0]).toMatchObject({ type: "tool_result", tool_use_id: "call_1" });
  });
});
