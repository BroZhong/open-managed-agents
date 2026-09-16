// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SplitWorkbench } from "./split-workbench";

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

function renderWorkbench() {
  return render(<SplitWorkbench workspace={<textarea aria-label="File draft" defaultValue="File content" />} session={<textarea aria-label="Session draft" defaultValue="" />} />);
}

it("keeps both drafts mounted while hiding and reopening Workspace", () => {
  renderWorkbench();
  const file = screen.getByRole("textbox", { name: "File draft" }) as HTMLTextAreaElement;
  const session = screen.getByRole("textbox", { name: "Session draft" }) as HTMLTextAreaElement;
  fireEvent.change(file, { target: { value: "Unsaved file changes" } });
  fireEvent.change(session, { target: { value: "Unsent instruction" } });
  fireEvent.click(screen.getByRole("button", { name: "Hide workspace" }));
  expect(screen.queryByRole("textbox", { name: "File draft" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show workspace" }));
  expect(screen.getByRole("textbox", { name: "File draft" })).toBe(file);
  expect(file.value).toBe("Unsaved file changes");
  expect(session.value).toBe("Unsent instruction");
});

it("supports bounded keyboard resizing and persists the desktop proportion", () => {
  renderWorkbench();
  const separator = screen.getByRole("separator");
  fireEvent.keyDown(separator, { key: "ArrowRight" });
  expect(separator.getAttribute("aria-valuenow")).toBe("60");
  fireEvent.keyDown(separator, { key: "End" });
  fireEvent.keyDown(separator, { key: "ArrowRight" });
  expect(separator.getAttribute("aria-valuenow")).toBe("70");
  expect(localStorage.getItem("oma_workspace_split")).toBe("70");
  fireEvent.doubleClick(separator);
  expect(separator.getAttribute("aria-valuenow")).toBe("58");
});

it("switches compact panes without remounting drafts or changing the desktop split", () => {
  let measure = () => {};
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { measure = callback; }
    observe() {} disconnect() {}
  });
  const view = renderWorkbench();
  const root = view.container.firstElementChild!;
  const file = screen.getByRole("textbox", { name: "File draft" }) as HTMLTextAreaElement;
  const session = screen.getByRole("textbox", { name: "Session draft" }) as HTMLTextAreaElement;
  fireEvent.change(file, { target: { value: "Keep file draft" } });
  fireEvent.change(session, { target: { value: "Keep Session draft" } });
  Object.defineProperty(root, "clientWidth", { configurable: true, value: 600 });
  act(() => measure());
  expect(screen.queryByRole("separator")).toBeNull();
  expect(screen.queryByRole("textbox", { name: "File draft" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
  expect(screen.getByRole("textbox", { name: "File draft" })).toBe(file);
  expect(screen.queryByRole("textbox", { name: "Session draft" })).toBeNull();
  Object.defineProperty(root, "clientWidth", { configurable: true, value: 1100 });
  act(() => measure());
  expect(screen.getByRole("textbox", { name: "Session draft" })).toBe(session);
  expect(file.value).toBe("Keep file draft");
  expect(session.value).toBe("Keep Session draft");
  expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("58");
});

it("reveals Workspace for a conversation path request without replacing mounted drafts", () => {
  const workspace = <textarea aria-label="File draft" defaultValue="Keep this draft" />;
  const session = <p>Conversation</p>;
  const view = render(<SplitWorkbench workspace={workspace} session={session} />);
  const draft = screen.getByRole("textbox", { name: "File draft" });
  fireEvent.click(screen.getByRole("button", { name: "Hide workspace" }));
  view.rerender(<SplitWorkbench workspace={workspace} session={session} revealWorkspaceKey={1} />);
  expect(screen.getByRole("textbox", { name: "File draft" })).toBe(draft);
});
