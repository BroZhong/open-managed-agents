import { describe, expect, it } from "vitest";
import { translateDevCodexTerminalEvent } from "../src/lib/dev-codex-events.js";

describe("development Codex terminal event translation", () => {
  it("records turn.completed usage exactly once", () => {
    const events = translateDevCodexTerminalEvent({
      type: "turn.completed",
      usage: {
        input_tokens: 120,
        output_tokens: 18,
        cached_input_tokens: 45,
      },
    });

    expect(events).toEqual([
      {
        type: "span.model_request_end",
        usage: {
          inputTokens: 120,
          outputTokens: 18,
          cacheReadTokens: 45,
          cacheWriteTokens: 0,
        },
      },
    ]);
  });

  it("records turn.failed usage before the Session error", () => {
    const events = translateDevCodexTerminalEvent({
      type: "turn.failed",
      error: { message: "rate limited" },
      usage: {
        input_tokens: 80,
        output_tokens: 7,
        cached_input_tokens: 30,
      },
    });

    expect(events).toEqual([
      {
        type: "span.model_request_end",
        usage: {
          inputTokens: 80,
          outputTokens: 7,
          cacheReadTokens: 30,
          cacheWriteTokens: 0,
        },
      },
      {
        type: "session.error",
        error: { message: "rate limited", code: "codex_error" },
      },
    ]);
  });

  it("records error-event usage before the Session error", () => {
    const events = translateDevCodexTerminalEvent({
      type: "error",
      message: "transport failed",
      usage: {
        input_tokens: 33,
        output_tokens: 2,
        cached_input_tokens: 11,
      },
    });

    expect(events.map((event) => event.type)).toEqual([
      "span.model_request_end",
      "session.error",
    ]);
    expect(events[0]).toEqual({
      type: "span.model_request_end",
      usage: {
        inputTokens: 33,
        outputTokens: 2,
        cacheReadTokens: 11,
        cacheWriteTokens: 0,
      },
    });
    expect(events[1]).toEqual({
      type: "session.error",
      error: { message: "transport failed", code: "codex_error" },
    });
  });

  it("emits only the Session error when a failed turn has no usage", () => {
    expect(
      translateDevCodexTerminalEvent({
        type: "turn.failed",
        error: { message: "authentication failed" },
      }),
    ).toEqual([
      {
        type: "session.error",
        error: { message: "authentication failed", code: "codex_error" },
      },
    ]);
  });

  it("ignores non-terminal events", () => {
    expect(
      translateDevCodexTerminalEvent({
        type: "item.completed",
        usage: { input_tokens: 999 },
      }),
    ).toEqual([]);
  });
});
