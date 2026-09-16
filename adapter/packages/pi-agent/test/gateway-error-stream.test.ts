import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { withGatewayErrors } from "../src/gateway-error-stream.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;
function message(errorMessage?: string, stopReason: AssistantMessage["stopReason"] = "error"): AssistantMessage {
  return {
    role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [{ type: "text", text: "partial response" }], stopReason, errorMessage,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: 1,
  };
}

describe("gateway error stream", () => {
  it.each([
    ["stream_read_error", "Network error: stream_read_error"],
    ["upstream_error: Upstream service temporarily unavailable", "Service unavailable: upstream_error: Upstream service temporarily unavailable"],
    ["429 AccountQuotaExceeded stream_read_error", "Quota exceeded: 429 AccountQuotaExceeded stream_read_error"],
    ["401 Invalid API key", "401 Invalid API key"],
    ["not_stream_read_error", "not_stream_read_error"],
  ])("preserves raw diagnostics and partial content: %s", async (raw, normalized) => {
    const source = createAssistantMessageEventStream();
    const original = message(raw);
    const start = { type: "start" as const, partial: original };
    source.push(start);
    source.push({ type: "error", reason: "error", error: original });
    const context = { messages: [] };
    const options = { signal: new AbortController().signal, apiKey: "test-only" };
    const stream = await withGatewayErrors(async (receivedModel, receivedContext, receivedOptions) => {
      expect(receivedModel).toBe(model);
      expect(receivedContext).toBe(context);
      expect(receivedOptions).toBe(options);
      return source;
    })(model, context, options);
    const events = [];
    for await (const event of stream) events.push(event);
    expect(events[0]).toBe(start);
    expect(events[1]).toEqual({ type: "error", reason: "error", error: { ...original, errorMessage: normalized } });
    expect(await stream.result()).toEqual({ ...original, errorMessage: normalized });
    expect(original.errorMessage).toBe(raw);
  });

  it.each(["stop", "aborted"] as const)("passes %s through unchanged", async stopReason => {
    const source = createAssistantMessageEventStream();
    const original = message("stream_read_error", stopReason);
    const terminal = stopReason === "stop"
      ? { type: "done" as const, reason: stopReason, message: original }
      : { type: "error" as const, reason: stopReason, error: original };
    source.push(terminal);
    const stream = await withGatewayErrors(() => source)(model, { messages: [] });
    const events = [];
    for await (const event of stream) events.push(event);
    expect(events).toEqual([terminal]);
    expect(await stream.result()).toBe(original);
  });

  it("propagates provider and iterator exceptions without a background pump", async () => {
    const error = new Error("provider failure");
    await expect(withGatewayErrors(() => { throw error; })(model, { messages: [] })).rejects.toBe(error);
    const source = createAssistantMessageEventStream();
    source[Symbol.asyncIterator] = async function* () { throw error; };
    const stream = await withGatewayErrors(() => source)(model, { messages: [] });
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toBe(error);
  });
});
