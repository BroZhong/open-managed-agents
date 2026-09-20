// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileSource } from "@/lib/file-source";

const mockedSources = vi.hoisted(() => new Map<string, unknown>());

vi.mock("@/lib/file-source", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/file-source")>();
  return {
    ...actual,
    createWorkspaceFileSource(workspaceId: string) {
      const source = mockedSources.get(workspaceId);
      if (!source) throw new Error(`Missing mocked source for ${workspaceId}`);
      return source;
    },
  };
});

import { WorkspacePanel } from "./workspace-panel";

afterEach(() => {
  cleanup();
  mockedSources.clear();
  vi.restoreAllMocks();
});

describe("WorkspacePanel Workspace isolation", () => {
  it("retains the last file tree and preview when a Turn-end refresh fails, and retries only the list", async () => {
    let unavailable = false;
    const list = vi.fn(async () => {
      if (unavailable) throw new Error("Storage unavailable");
      return [{ path: "saved.txt", isDir: false, size: 5 }];
    });
    mockedSources.set("workspace-a", {
      capabilities: { hierarchy: "nested", idleGated: false },
      list,
      read: async () => ({ path: "saved.txt", text: "saved content", contentType: "text/plain", size: 13, isBinary: false }),
    } satisfies FileSource);
    const view = render(<WorkspacePanel workspaceId="workspace-a" refreshKey={0} />);
    fireEvent.click(await screen.findByText("saved.txt"));
    expect(await screen.findByText("saved content")).toBeTruthy();
    unavailable = true;
    view.rerender(<WorkspacePanel workspaceId="workspace-a" refreshKey={1} />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getAllByText("saved.txt").length).toBeGreaterThan(0);
    expect(screen.getByText("saved content")).toBeTruthy();
    expect(screen.queryByText(/No files yet/)).toBeNull();
    unavailable = false;
    fireEvent.click(screen.getByTitle("Refresh"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("drops Workspace A content when switching to Workspace B", async () => {
    const sourceA: FileSource = {
      capabilities: { hierarchy: "nested", idleGated: false },
      list: async () => [{ path: "a.png", isDir: false, size: 3 }],
      read: async () => ({
        path: "a.png",
        text: null,
        contentType: "image/png",
        size: 3,
        isBinary: true,
      }),
      previewUrl: async () => "https://files.test/workspace-a",
    };
    const sourceB: FileSource = {
      capabilities: { hierarchy: "nested", idleGated: false },
      list: async () => [{ path: "b.txt", isDir: false, size: 1 }],
      read: async () => ({
        path: "b.txt",
        text: "B",
        contentType: "text/plain",
        size: 1,
        isBinary: false,
      }),
    };
    mockedSources.set("workspace-a", sourceA);
    mockedSources.set("workspace-b", sourceB);

    const view = render(
      <WorkspacePanel workspaceId="workspace-a" refreshKey={0} />,
    );
    fireEvent.click(await screen.findByText("a.png"));
    expect((await screen.findByRole("img", { name: "a.png" })).getAttribute("src"))
      .toBe("https://files.test/workspace-a");

    view.rerender(
      <WorkspacePanel workspaceId="workspace-b" refreshKey={0} />,
    );

    expect(screen.queryByRole("img", { name: "a.png" })).toBeNull();
    expect(await screen.findByText("b.txt")).toBeTruthy();
    expect(screen.queryByText("a.png")).toBeNull();
  });
});

it("searches nested paths and preserves unsaved Markdown when switching Preview and Edit", async () => {
  mockedSources.set("workspace-notes", {
    capabilities: { hierarchy: "nested", idleGated: false },
    list: async () => [
      { path: "notes/decision.md", isDir: false, size: 24 },
      { path: "readme.txt", isDir: false, size: 8 },
    ],
    read: async (path) => ({ path, text: "# Decision\n\nInitial notes.", contentType: "text/markdown", size: 24, isBinary: false }),
    write: vi.fn(async () => {}),
  } satisfies FileSource);
  render(<WorkspacePanel workspaceId="workspace-notes" refreshKey={0} />);
  await screen.findByText("notes");
  fireEvent.change(screen.getByRole("textbox", { name: "Search files" }), { target: { value: "decision" } });
  fireEvent.click(await screen.findByText("decision.md"));
  expect(await screen.findByRole("heading", { name: "Decision" })).toBeTruthy();
  expect(screen.queryByText("readme.txt")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  const editor = screen.getByRole("textbox", { name: "File content" }) as HTMLTextAreaElement;
  fireEvent.change(editor, { target: { value: "# Revised decision\n\nUnsaved notes." } });
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  expect(await screen.findByRole("heading", { name: "Revised decision" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect((screen.getByRole("textbox", { name: "File content" }) as HTMLTextAreaElement).value).toContain("Unsaved notes.");
  fireEvent.change(screen.getByRole("textbox", { name: "Search files" }), { target: { value: "" } });
  expect(await screen.findByText("readme.txt")).toBeTruthy();
  expect((screen.getByRole("textbox", { name: "File content" }) as HTMLTextAreaElement).value).toContain("Unsaved notes.");
});

it("creates folders and files inline, preserves existing names, and collapses the tree", async () => {
  const files = new Map([["notes/existing.md", "# Existing"]]);
  const folders = new Set<string>();
  const source: FileSource = {
    capabilities: { hierarchy: "nested", idleGated: false },
    list: async () => [...Array.from(files, ([path]) => ({ path, isDir: false })), ...Array.from(folders, (path) => ({ path, isDir: true }))],
    read: async (path) => ({ path, text: files.get(path) ?? "", contentType: "text/markdown", size: 1, isBinary: false }),
    write: vi.fn(async (path, content) => { files.set(path, content); }),
    createDirectory: vi.fn(async (path) => { folders.add(path); }),
  };
  mockedSources.set("workspace-create", source);
  render(<WorkspacePanel workspaceId="workspace-create" refreshKey={0} />);
  await screen.findByText("notes");
  fireEvent.click(screen.getByRole("button", { name: "New folder" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Folder name" }), { target: { value: "assets" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(source.createDirectory).toHaveBeenCalledWith("assets"));
  expect(await screen.findByRole("button", { name: "assets" })).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Folder name" })).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "New file" }));
  expect((screen.getByRole("textbox", { name: "File name" }) as HTMLInputElement).value).toBe("assets/untitled.md");
  fireEvent.change(screen.getByRole("textbox", { name: "File name" }), { target: { value: "notes/existing.md" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(source.write).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox", { name: "File name" }), { target: { value: "assets/plan.md" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(await screen.findByRole("heading", { name: "plan" })).toBeTruthy();
  expect(source.write).toHaveBeenCalledWith("assets/plan.md", "# plan\n");
  fireEvent.click(screen.getByRole("button", { name: "Collapse folders" }));
  expect(screen.queryByRole("button", { name: "plan.md" })).toBeNull();
  expect(screen.getByRole("heading", { name: "plan" })).toBeTruthy();
});

it("reveals linked files through collapsed folders and search, including repeated selections", async () => {
  const read = vi.fn(async (path: string) => ({ path, text: `Content of ${path}`, contentType: "text/plain", size: 10, isBinary: false }));
  mockedSources.set("workspace-linked", {
    capabilities: { hierarchy: "nested", idleGated: false },
    list: async () => [{ path: "novel/reviews/check.txt", isDir: false }, { path: "other.txt", isDir: false }],
    read,
  } satisfies FileSource);
  const view = render(<WorkspacePanel workspaceId="workspace-linked" refreshKey={0} />);
  await screen.findByRole("button", { name: "novel" });
  fireEvent.change(screen.getByRole("textbox", { name: "Search files" }), { target: { value: "other" } });
  view.rerender(<WorkspacePanel workspaceId="workspace-linked" refreshKey={0} fileSelection={{ path: "novel/reviews/check.txt", nonce: 1 }} />);
  await screen.findByText("Content of novel/reviews/check.txt");
  expect(screen.getByRole("button", { name: /check\.txt/ }).getAttribute("aria-current")).toBe("true");
  expect(screen.getByRole("textbox", { name: "Search files" })).toHaveProperty("value", "");
  fireEvent.click(screen.getByRole("button", { name: /other\.txt/ }));
  await screen.findByText("Content of other.txt");
  view.rerender(<WorkspacePanel workspaceId="workspace-linked" refreshKey={0} fileSelection={{ path: "novel/reviews/check.txt", nonce: 2 }} />);
  await screen.findByText("Content of novel/reviews/check.txt");
  expect(screen.getByRole("button", { name: /check\.txt/ }).getAttribute("aria-current")).toBe("true");
});
