// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceFileSource } from "./file-source";

afterEach(() => vi.unstubAllGlobals());

describe("Workspace file list responses", () => {
  it("uses the Workspace ID for every file operation", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetch);
    const source = createWorkspaceFileSource("workspace_123");
    await source.list();
    await source.write!("a.txt", "hello");
    await source.rename!("a.txt", "b.txt");
    await source.delete!("b.txt");
    await source.upload!([new File(["hello"], "a.txt")], "outputs");
    await source.read("outputs/a.txt");
    const paths = fetch.mock.calls.map((call) => new URL(String(call[0]), "http://localhost").pathname);
    expect(paths).toEqual([
      "/v1/workspaces/workspace_123/files",
      "/v1/workspaces/workspace_123/files/content",
      "/v1/workspaces/workspace_123/files/rename",
      "/v1/workspaces/workspace_123/files/content",
      "/v1/workspaces/workspace_123/files/upload",
      "/v1/workspaces/workspace_123/files/outputs/a.txt",
    ]);
    expect(source.capabilities.idleGated).toBe(false);
  });

  it("treats an incomplete successful response as unconfirmed, not an empty Workspace", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({})));
    await expect(createWorkspaceFileSource("workspace").list()).rejects.toThrow("File status is unconfirmed");
  });

  it("accepts a confirmed empty Workspace and propagates storage failures", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [] }))
      .mockResolvedValueOnce(Response.json({ error: "Workspace storage is unavailable" }, { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const source = createWorkspaceFileSource("workspace");
    await expect(source.list()).resolves.toEqual([]);
    await expect(source.list()).rejects.toThrow("Workspace storage is unavailable");
  });
});
