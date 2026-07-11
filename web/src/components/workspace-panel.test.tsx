// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileSource } from "@/lib/file-source";

const mockedSources = vi.hoisted(() => new Map<string, unknown>());

vi.mock("@/lib/file-source", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/file-source")>();
  return {
    ...actual,
    createWorkspaceFileSource(sessionId: string) {
      const source = mockedSources.get(sessionId);
      if (!source) throw new Error(`Missing mocked source for ${sessionId}`);
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

describe("WorkspacePanel session isolation", () => {
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    revokeObjectURL.mockReset();
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });
  });

  it("drops Session A content and revokes its Blob when switching to Session B", async () => {
    const sourceA: FileSource = {
      capabilities: { hierarchy: "nested", idleGated: true },
      list: async () => [{ path: "a.png", isDir: false, size: 3 }],
      read: async () => ({
        path: "a.png",
        text: null,
        contentType: "image/png",
        size: 3,
        isBinary: true,
      }),
      previewUrl: async () => "blob:session-a",
    };
    const sourceB: FileSource = {
      capabilities: { hierarchy: "nested", idleGated: true },
      list: async () => [{ path: "b.txt", isDir: false, size: 1 }],
      read: async () => ({
        path: "b.txt",
        text: "B",
        contentType: "text/plain",
        size: 1,
        isBinary: false,
      }),
    };
    mockedSources.set("session-a", sourceA);
    mockedSources.set("session-b", sourceB);

    const view = render(
      <WorkspacePanel sessionId="session-a" refreshKey={0} turnStatus="idle" />,
    );
    fireEvent.click(await screen.findByText("a.png"));
    expect((await screen.findByRole("img", { name: "a.png" })).getAttribute("src"))
      .toBe("blob:session-a");

    view.rerender(
      <WorkspacePanel sessionId="session-b" refreshKey={0} turnStatus="idle" />,
    );

    expect(screen.queryByRole("img", { name: "a.png" })).toBeNull();
    expect(await screen.findByText("b.txt")).toBeTruthy();
    expect(screen.queryByText("a.png")).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:session-a");
  });
});
