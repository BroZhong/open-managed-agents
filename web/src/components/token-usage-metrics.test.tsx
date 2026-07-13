// @vitest-environment jsdom

import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TokenUsageMetrics } from "@/components/token-usage-metrics";

afterEach(cleanup);

it("renders input, output, cache usage, and cache hit rate", () => {
  render(
    <TokenUsageMetrics
      usage={{
        inputTokens: 1250,
        outputTokens: 80,
        cacheReadTokens: 500,
        cacheWriteTokens: 100,
        totalTokens: 1330,
        cacheHitRate: 0.4,
      }}
    />,
  );

  expect(screen.getByText("1,330")).toBeTruthy();
  expect(screen.getByText("1,250")).toBeTruthy();
  expect(screen.getByText("80")).toBeTruthy();
  expect(screen.getByText("500")).toBeTruthy();
  expect(screen.getByText("100")).toBeTruthy();
  expect(screen.getByText("40.0%")).toBeTruthy();
});
