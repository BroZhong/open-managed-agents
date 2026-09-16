// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SidebarItemActions } from "./sidebar-item-actions";
afterEach(cleanup);

it.each(["Session", "Workspace"] as const)("renames and deletes a %s through its actions menu", async (kind) => {
  const rename = vi.fn(async () => {});
  const remove = vi.fn(async () => {});
  render(<SidebarItemActions kind={kind} label="Original" onRename={rename} onDelete={remove} />);
  fireEvent.click(screen.getByRole("button", { name: `${kind} actions` }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
  fireEvent.change(screen.getByRole("textbox", { name: `${kind} name` }), { target: { value: "  Renamed  " } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(rename).toHaveBeenCalledWith("Renamed"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: `${kind} actions` }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
  await waitFor(() => expect(remove).toHaveBeenCalledOnce());
});

it("cancels renaming without a mutation and dismisses the menu with Escape", () => {
  const rename = vi.fn();
  render(<SidebarItemActions kind="Session" label="Original" onRename={rename} onDelete={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(rename).not.toHaveBeenCalled();
});
