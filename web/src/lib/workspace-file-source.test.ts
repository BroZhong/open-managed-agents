// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceFileSource } from "./file-source";

afterEach(() => vi.unstubAllGlobals());

describe("Workspace file list responses", () => {
  it("uses the Workspace ID for every file operation", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ data: [] }));
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

it("persists an empty folder and lists its marker as a directory", async () => {
  const fetchMock = vi.fn(async (_url, init?: RequestInit) => new Response(JSON.stringify(init?.method === "PUT" ? { path: "assets/.oma-directory" } : {
    data: [{ path: "assets/.oma-directory", size: 0, updated_at: null }, { path: "notes.md", size: 2, updated_at: null }],
  })));
  vi.stubGlobal("fetch", fetchMock);
  const source = createWorkspaceFileSource("workspace-a");
  await source.createDirectory!("assets");
  expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({ path: "assets/.oma-directory", content: "" });
  expect(await source.list()).toEqual([
    { path: "assets", isDir: true, size: 0, updatedAt: undefined },
    { path: "notes.md", isDir: false, size: 2, updatedAt: undefined },
  ]);
});

it("recognizes directory flags, trailing slashes and implicit parent entries", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [
    { path: "chapters", size: 0 },
    { path: "chapters/EP1.txt", size: 100 },
    { path: "empty/", size: 0 },
    { path: "flagged", isDir: true, size: 0 },
    { path: "empty-file.txt", size: 0 },
  ] })));
  const nodes = await createWorkspaceFileSource("workspace").list();
  expect(nodes.map(({ path, isDir }) => ({ path, isDir }))).toEqual([
    { path: "chapters", isDir: true }, { path: "chapters/EP1.txt", isDir: false },
    { path: "empty", isDir: true }, { path: "flagged", isDir: true }, { path: "empty-file.txt", isDir: false },
  ]);
});
