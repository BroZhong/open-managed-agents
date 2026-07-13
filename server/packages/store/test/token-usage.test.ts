import { describe, expect, it } from "vitest";
import { summarizeTokenUsage } from "../src/index.js";

describe("summarizeTokenUsage", () => {
  it("derives total tokens and cache hit rate from provider-neutral counts", () => {
    expect(
      summarizeTokenUsage({
        inputTokens: 100,
        outputTokens: 25,
        cacheReadTokens: 40,
        cacheWriteTokens: 10,
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      totalTokens: 125,
      cacheHitRate: 0.4,
    });
  });

  it("normalizes invalid counts and leaves an empty hit rate unknown", () => {
    expect(
      summarizeTokenUsage({
        inputTokens: Number.NaN,
        outputTokens: -1,
        cacheReadTokens: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      cacheHitRate: null,
    });
  });
});
