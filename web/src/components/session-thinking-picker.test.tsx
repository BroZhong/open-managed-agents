// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SessionThinkingPicker } from "./session-thinking-picker";
afterEach(cleanup);
const options = {
  model: "openai-codex/gpt-6-astra",
  choices: ["low", "medium", "high", "xhigh", "max"].map(level => ({ value: level, label: level })),
  resolvedLevels: { off: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
  defaultLevel: "max",
} as import("@/lib/hooks/use-thinking-options").ThinkingOptions;


it("inherits Agent thinking, commits the slider, and resets to inheritance", async () => {
  const onChange = vi.fn().mockResolvedValue(undefined);
  render(<SessionThinkingPicker options={options} model="openai-codex/gpt-6-astra" inherited="medium" onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "思考强度：中，继承 Agent" }));
  const slider = screen.getByRole("slider") as HTMLInputElement;
  expect(slider.value).toBe("1");
  fireEvent.change(slider, { target: { value: "2" } });
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.pointerUp(slider);
  await waitFor(() => expect(onChange).toHaveBeenCalledWith("high"));
  await waitFor(() => expect(screen.getByRole("button", { name: "恢复 Agent 设置" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "恢复 Agent 设置" }));
  await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(null));
  await waitFor(() => expect(slider.value).toBe("1"));
});

it("restores a persisted preference and saves keyboard changes", async () => {
  const onChange = vi.fn().mockResolvedValue(undefined);
  render(<SessionThinkingPicker options={options} value="high" inherited="max" onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "思考强度：高" }));
  const slider = screen.getByRole("slider");
  fireEvent.change(slider, { target: { value: "0" } });
  fireEvent.keyUp(slider, { key: "Home" });
  await waitFor(() => expect(onChange).toHaveBeenCalledWith("low"));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("rolls back a failed save and reports it without claiming success", async () => {
  const onChange = vi.fn().mockRejectedValue(new Error("offline"));
  render(<SessionThinkingPicker options={options} value="low" onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "思考强度：低" }));
  const slider = screen.getByRole("slider") as HTMLInputElement;
  fireEvent.change(slider, { target: { value: "4" } });
  fireEvent.pointerUp(slider);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "保存失败，请重试");
  expect(slider.value).toBe("0");
});

it("does not invent levels while unavailable and offers retry", () => {
  const retry = vi.fn();
  render(<SessionThinkingPicker onChange={vi.fn()} onRetry={retry} />);
  fireEvent.click(screen.getByRole("button", { name: /思考强度/ }));
  expect(screen.queryByRole("slider")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "档位读取失败，重试" }));
  expect(retry).toHaveBeenCalledOnce();
});

it("displays five Astra stops and resolves an inherited minimal alias to low", () => {
  render(<SessionThinkingPicker options={options} inherited="minimal" onChange={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "思考强度：低，继承 Agent" }));
  expect(screen.getByRole("slider").getAttribute("max")).toBe("4");
  expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("低");
});
