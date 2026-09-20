// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SessionUsageFooter } from "./session-usage-footer";
import type { SessionEvent } from "@/lib/types";

afterEach(cleanup);
const event = (seq: number, type: string, data: unknown): SessionEvent => ({ seq, type, data, ts: "2026-09-21T00:00:00Z" });
const before = event(2, "agent.context_usage", { model: "openai-codex/gpt-6-astra", contextWindow: 272000, tokens: 266685, source: "sdk" });
const compact = event(3, "agent.compaction", { status: "completed", estimatedTokensAfter: 24208 });
const after = event(4, "agent.context_usage", { model: "openai-codex/gpt-6-astra", contextWindow: 272000, tokens: 24208, source: "estimate" });

it("places current context after cumulative Total tokens and updates through compaction and reload", () => {
  const history = [event(1, "span.model_request_end", { usage: { inputTokens: 500000, outputTokens: 23 } }), before];
  const view = render(<SessionUsageFooter events={history} />);
  expect([...view.container.querySelectorAll("dt")].map(el => el.textContent)).toEqual(["Total tokens", "Context", "KV cache hit"]);
  expect(screen.getByText("500,023")).toBeTruthy();
  expect(screen.getByText("≈266,685 / 272,000 · 98.0%")).toBeTruthy();
  view.rerender(<SessionUsageFooter events={[...history, compact]} />);
  expect(screen.getByText("— / 272,000")).toBeTruthy();
  view.rerender(<SessionUsageFooter events={[...history, compact, after]} />);
  expect(screen.getByText("≈24,208 / 272,000 · 8.9%")).toBeTruthy();
  expect(screen.getByTitle(/Estimated from the current messages after compaction/)).toBeTruthy();
  view.unmount();
  render(<SessionUsageFooter events={[...history, compact, after]} />);
  expect(screen.getByText("≈24,208 / 272,000 · 8.9%")).toBeTruthy();
  expect(screen.getByText("500,023")).toBeTruthy();
});

it("shows unknown for legacy history instead of interpreting cumulative usage as context", () => {
  const { container } = render(<SessionUsageFooter events={[event(1, "span.model_request_end", { usage: { inputTokens: 500000 } })]} />);
  expect(container.querySelectorAll("dd")[1].textContent).toBe("—");
});

it("uses the latest model window and permits occupancy over 100%", () => {
  render(<SessionUsageFooter events={[before, event(3, "agent.context_usage", { tokens: 1100, contextWindow: 1000, source: "sdk", model: "another/model" })]} />);
  expect(screen.getByText("≈1,100 / 1,000 · 110.0%")).toBeTruthy();
});
