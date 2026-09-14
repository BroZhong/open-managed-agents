import { describe, expect, it } from "vitest";
import {
  summarizeTokenUsage,
  tokenUsageFromResponse,
} from "@/lib/token-usage";
import type { SessionEvent } from "@/lib/types";

function event(
  seq: number,
  usage: Record<string, number>,
): SessionEvent {
  return {
    seq,
    type: "span.model_request_end",
    data: { usage },
    ts: "2026-07-14T00:00:00.000Z",
  };
}

describe("summarizeTokenUsage", () => {
  it("sums model requests without double-counting cached input", () => {
    const summary = summarizeTokenUsage([
      event(1, {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 40,
        cacheWriteTokens: 10,
      }),
      event(2, {
        inputTokens: 50,
        outputTokens: 10,
        cacheReadTokens: 5,
        cacheWriteTokens: 0,
      }),
      {
        seq: 3,
        type: "agent.message",
        data: { usage: { inputTokens: 999 } },
        ts: "2026-07-14T00:00:00.000Z",
      },
    ]);

    expect(summary).toEqual({
      inputTokens: 150,
      outputTokens: 30,
      cacheReadTokens: 45,
      cacheWriteTokens: 10,
      totalTokens: 180,
      cacheHitRate: 0.3,
    });
  });

  it("supports legacy events and returns a null hit rate with no input", () => {
    expect(
      summarizeTokenUsage([
        event(1, { inputTokens: 0, outputTokens: 12 }),
      ]),
    ).toEqual({
      inputTokens: 0,
      outputTokens: 12,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 12,
      cacheHitRate: null,
    });
  });

  it("normalizes the API response with the same total and hit-rate rules", () => {
    expect(
      tokenUsageFromResponse({
        input_tokens: 200,
        output_tokens: 40,
        cache_read_tokens: 50,
        cache_write_tokens: 10,
        // The UI protects the invariant instead of trusting derived wire data.
        total_tokens: 999,
        cache_hit_rate: 0.99,
      }),
    ).toMatchObject({ totalTokens: 240, cacheHitRate: 0.25 });
  });
});
