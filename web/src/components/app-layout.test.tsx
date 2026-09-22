// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { AuthProvider } from "@/lib/auth";
import { AppLayout } from "./app-layout";

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

function renderLayout() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AuthProvider><MemoryRouter><AppLayout /></MemoryRouter></AuthProvider>
    </QueryClientProvider>,
  );
}

it("resizes by dragging, bounds the width, and stops on release or cancellation", () => {
  vi.stubGlobal("PointerEvent", class extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  });
  const view = renderLayout();
  const separator = screen.getByRole("separator", { name: "Resize sidebar" });
  const captured = new Set<number>();
  Object.assign(separator, {
    setPointerCapture: (id: number) => captured.add(id),
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => captured.delete(id),
  });
  const move = (clientX: number) => fireEvent.pointerMove(separator, { pointerId: 1, clientX });
  move(380);
  expect(separator.getAttribute("aria-valuenow")).toBe("224");
  fireEvent.pointerDown(separator, { pointerId: 1, button: 0, clientX: 224 });
  expect(captured.has(1)).toBe(true);
  move(380);
  expect(separator.getAttribute("aria-valuenow")).toBe("380");
  expect((view.container.firstElementChild as HTMLElement).style.getPropertyValue("--sidebar-expanded-width")).toBe("380px");
  move(1000);
  expect(separator.getAttribute("aria-valuenow")).toBe("480");
  move(100);
  expect(separator.getAttribute("aria-valuenow")).toBe("200");
  move(320);
  fireEvent.pointerUp(separator, { pointerId: 1 });
  expect(captured.has(1)).toBe(false);
  move(400);
  expect(localStorage.getItem("oma_sidebar_width")).toBe("320");
  expect(view.container.firstElementChild?.getAttribute("data-resizing")).toBe("false");

  fireEvent.pointerDown(separator, { pointerId: 1, button: 0, clientX: 320 });
  fireEvent.pointerCancel(separator, { pointerId: 1 });
  move(400);
  expect(separator.getAttribute("aria-valuenow")).toBe("320");
  expect(view.container.firstElementChild?.getAttribute("data-resizing")).toBe("false");
});

it("retains the chosen width across collapse and remount, with keyboard resizing and reset", () => {
  const view = renderLayout();
  fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowRight" });
  expect(localStorage.getItem("oma_sidebar_width")).toBe("240");
  fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
  expect(screen.queryByRole("separator")).toBeNull();
  expect(view.container.firstElementChild?.getAttribute("data-collapsed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
  expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("240");
  view.unmount();
  renderLayout();
  const separator = screen.getByRole("separator");
  expect(separator.getAttribute("aria-valuenow")).toBe("240");
  fireEvent.keyDown(separator, { key: "End" });
  fireEvent.keyDown(separator, { key: "ArrowRight" });
  expect(separator.getAttribute("aria-valuenow")).toBe("480");
  fireEvent.keyDown(separator, { key: "Home" });
  fireEvent.keyDown(separator, { key: "ArrowLeft" });
  expect(separator.getAttribute("aria-valuenow")).toBe("200");
  fireEvent.doubleClick(separator);
  expect(localStorage.getItem("oma_sidebar_width")).toBe("224");
});

it.each([["invalid", "224"], ["9999", "480"], ["-10", "200"]])("handles an invalid stored width of %s", (stored, expected) => {
  localStorage.setItem("oma_sidebar_width", stored);
  renderLayout();
  expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe(expected);
});
