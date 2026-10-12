// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgentThinkingPicker } from "./agent-thinking-picker";
import type { ThinkingOptions } from "@/lib/hooks/use-thinking-options";

afterEach(cleanup);
const fallback: ThinkingOptions = {
  model: "custom-one/global.anthropic.claude-opus-5-5", source: "default",
  choices: [{ value: "off", label: "off" }, { value: "minimal", label: "minimal" }, { value: "low", label: "low" }, { value: "medium", label: "medium" }, { value: "high", label: "high" }],
  resolvedLevels: { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" },
  defaultLevel: "high",
};

it("describes unknown model defaults as request preferences, not its highest capability", () => {
  const change = vi.fn();
  const { rerender } = render(<AgentThinkingPicker options={fallback} onChange={change} loading={false} onRetry={vi.fn()} />);
  expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("自动 · 默认高");
  expect(screen.queryByText(/模型最高/)).toBeNull();
  expect(screen.getByText("基础档位，接入服务支持情况未确认。")).toBeTruthy();
  expect(screen.getByText("关闭?")).toBeTruthy();
  fireEvent.change(screen.getByRole("slider"), { target: { value: "0" } });
  expect(change).toHaveBeenCalledWith("off");
  rerender(<AgentThinkingPicker options={fallback} value="off" onChange={change} loading={false} onRetry={vi.fn()} />);
  expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("请求关闭（未确认）");
});

it("keeps catalog-referenced controls and explicit non-support distinct from unknown capabilities", () => {
  const props = { onChange: vi.fn(), loading: false, onRetry: vi.fn() };
  const { rerender } = render(<AgentThinkingPicker {...props} options={{ ...fallback, source: "manual", reference: { provider: "anthropic", modelId: "claude-opus-5" } }} />);
  expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("自动 · 模型最高 · 高");
  expect(screen.queryByText(/未确认/)).toBeNull();
  rerender(<AgentThinkingPicker {...props} options={{ ...fallback, source: "upstream", choices: [{ value: "off", label: "off" }], defaultLevel: "off" }} />);
  expect(screen.getByRole("slider")).toHaveProperty("disabled", true);
  expect(screen.getByText("不支持思考")).toBeTruthy();
  expect(screen.queryByText(/未确认/)).toBeNull();
});
