// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    revokeObjectURL.mockReset();
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });
  });

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

  it("drops Workspace A content and revokes its Blob when switching to Workspace B", async () => {
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
      previewUrl: async () => "blob:workspace-a",
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
      .toBe("blob:workspace-a");

    view.rerender(
      <WorkspacePanel workspaceId="workspace-b" refreshKey={0} />,
    );

    expect(screen.queryByRole("img", { name: "a.png" })).toBeNull();
    expect(await screen.findByText("b.txt")).toBeTruthy();
    expect(screen.queryByText("a.png")).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:workspace-a");
  });
});
