// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SessionThinkingPicker } from "./session-thinking-picker";
afterEach(cleanup);

it("inherits Agent thinking, commits the slider, and resets to inheritance", async () => {
  const onChange = vi.fn().mockResolvedValue(undefined);
  render(<SessionThinkingPicker model="openai-codex/gpt-6-astra" inherited="medium" onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "思考强度：中，继承 Agent" }));
  const slider = screen.getByRole("slider") as HTMLInputElement;
  expect(slider.value).toBe("3");
  fireEvent.change(slider, { target: { value: "4" } });
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.pointerUp(slider);
  await waitFor(() => expect(onChange).toHaveBeenCalledWith("high"));
  await waitFor(() => expect(screen.getByRole("button", { name: "恢复 Agent 设置" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "恢复 Agent 设置" }));
  await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(null));
  await waitFor(() => expect(slider.value).toBe("3"));
});

it("restores a persisted preference and saves keyboard changes", async () => {
  const onChange = vi.fn().mockResolvedValue(undefined);
  render(<SessionThinkingPicker value="low" inherited="max" onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "思考强度：低" }));
  const slider = screen.getByRole("slider");
  fireEvent.change(slider, { target: { value: "0" } });
  fireEvent.keyUp(slider, { key: "Home" });
  await waitFor(() => expect(onChange).toHaveBeenCalledWith("off"));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("rolls back a failed save and reports it without claiming success", async () => {
  const onChange = vi.fn().mockRejectedValue(new Error("offline"));
  render(<SessionThinkingPicker value="low" onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "思考强度：低" }));
  const slider = screen.getByRole("slider") as HTMLInputElement;
  fireEvent.change(slider, { target: { value: "6" } });
  fireEvent.pointerUp(slider);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "保存失败，请重试");
  expect(slider.value).toBe("2");
});
