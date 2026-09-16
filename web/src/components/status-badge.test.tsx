// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StatusBadge } from "./status-badge";

afterEach(cleanup);

it.each(["idle", "terminated"] as const)("renders no status for %s Sessions", (status) => {
  const { container } = render(<StatusBadge status={status} />);
  expect(container.childElementCount).toBe(0);
});

it.each(["running", "waiting"] as const)("shows only a spinner for %s Sessions", (status) => {
  render(<StatusBadge status={status} />);
  const indicator = screen.getByRole("img", { name: "Session running" });
  expect(indicator.querySelector(".animate-spin")).toBeTruthy();
  expect(indicator.textContent).toBe("");
});

it("removes the spinner when a Session stops", () => {
  const { rerender, container } = render(<StatusBadge status="running" />);
  rerender(<StatusBadge status="idle" />);
  expect(container.childElementCount).toBe(0);
});
