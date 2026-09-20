// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceFileSource } from "./file-source";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear(); });

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
    fetch.mockResolvedValueOnce(Response.json(readLink("outputs/film.mp4")));
    await source.read("outputs/film.mp4");
    const paths = fetch.mock.calls.map((call) => new URL(String(call[0]), "http://localhost").pathname);
    expect(paths).toEqual([
      "/v1/workspaces/workspace_123/files",
      "/v1/workspaces/workspace_123/files/content",
      "/v1/workspaces/workspace_123/files/rename",
      "/v1/workspaces/workspace_123/files/content",
      "/v1/workspaces/workspace_123/files/upload",
      "/v1/workspaces/workspace_123/files/outputs/film.mp4",
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

function readLink(path = "film.mp4", overrides: Record<string, unknown> = {}) {
  return {
    path, url: `https://files.example.test/${path}?signature=first`,
    expiresAt: new Date(Date.now() + 600_000).toISOString(), expiresIn: 600,
    size: 50 * 1024 * 1024, contentType: "video/mp4", ...overrides,
  };
}

describe("Workspace signed reads", () => {
  it.each(["film.mp4", "poster.jpg", "drawing.svg", "voice.mp3"])("reads metadata and mounts %s without downloading its body", async (path) => {
    const link = readLink(path, { contentType: "text/plain" });
    const fetch = vi.fn().mockResolvedValue(Response.json(link));
    vi.stubGlobal("fetch", fetch);
    localStorage.setItem("oma_api_key", "api-secret");
    const source = createWorkspaceFileSource("workspace");
    expect(await source.read(path)).toEqual({ path, text: null, contentType: "text/plain", size: 50 * 1024 * 1024, isBinary: true });
    expect(await source.previewUrl!(path)).toBe(link.url);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).toMatchObject({ headers: { Authorization: "Bearer api-secret" }, cache: "no-store" });
  });

  it("fetches small text from storage without application credentials", async () => {
    const link = readLink("notes.md", { size: 5, contentType: "application/octet-stream" });
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(link)).mockResolvedValueOnce(new Response("hello"));
    vi.stubGlobal("fetch", fetch);
    localStorage.setItem("oma_api_key", "api-secret");
    expect(await createWorkspaceFileSource("workspace").read("notes.md")).toMatchObject({ text: "hello", isBinary: false });
    expect(fetch.mock.calls[0][1].headers).toEqual({ Authorization: "Bearer api-secret" });
    expect(fetch.mock.calls[1]).toEqual([link.url, { signal: expect.any(AbortSignal), credentials: "omit", cache: "no-store" }]);
  });

  it("does not fetch oversized text", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(readLink("large.txt", { contentType: "text/plain" })));
    vi.stubGlobal("fetch", fetch);
    expect(await createWorkspaceFileSource("workspace").read("large.txt")).toMatchObject({ text: null, isBinary: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("cancels a text body that grew beyond the preview cap", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(512 * 1024 + 1)); }, cancel,
    });
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(readLink("notes.txt", { size: 1, contentType: "text/plain" }))).mockResolvedValueOnce(new Response(stream));
    vi.stubGlobal("fetch", fetch);
    expect(await createWorkspaceFileSource("workspace").read("notes.txt")).toMatchObject({ text: null, isBinary: true });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("bypasses cached links on explicit refresh and near expiry", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(readLink()))
      .mockResolvedValueOnce(Response.json(readLink("film.mp4", { url: "https://files.example.test/second", expiresAt: new Date(Date.now() + 10_000).toISOString() })))
      .mockResolvedValueOnce(Response.json(readLink("film.mp4", { url: "https://files.example.test/third" })));
    vi.stubGlobal("fetch", fetch);
    const source = createWorkspaceFileSource("workspace");
    await source.read("film.mp4");
    expect(await source.previewUrl!("film.mp4", { forceRefresh: true })).toBe("https://files.example.test/second");
    expect(await source.previewUrl!("film.mp4")).toBe("https://files.example.test/third");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("reauthorizes a new selection of the same path", async () => {
    const fetch = vi.fn(async () => Response.json(readLink()));
    vi.stubGlobal("fetch", fetch);
    const source = createWorkspaceFileSource("workspace");
    await source.read("film.mp4");
    await source.read("film.mp4");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("always signs fresh attachment downloads and never consumes the body", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(readLink())).mockResolvedValueOnce(Response.json(readLink("film.mp4", { url: "https://files.example.test/download" })));
    vi.stubGlobal("fetch", fetch);
    const source = createWorkspaceFileSource("workspace");
    await source.read("film.mp4");
    expect(await source.downloadUrl!("film.mp4")).toBe("https://files.example.test/download");
    expect(fetch.mock.calls[1][0]).toContain("/files/film.mp4?download=1");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("propagates selection cancellation to the signing request", async () => {
    const controller = new AbortController();
    const fetch = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(options.signal!.reason));
    }));
    vi.stubGlobal("fetch", fetch);
    const pending = createWorkspaceFileSource("workspace").read("film.mp4", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch.mock.calls[0][1].signal!.aborted).toBe(true);
  });

  it("propagates cancellation while reading text from storage", async () => {
    const controller = new AbortController();
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(readLink("notes.txt", { size: 1, contentType: "text/plain" })))
      .mockImplementationOnce((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
        options.signal!.addEventListener("abort", () => reject(options.signal!.reason));
        controller.abort();
      }));
    vi.stubGlobal("fetch", fetch);
    await expect(createWorkspaceFileSource("workspace").read("notes.txt", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("refreshes an expired text link only once", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(readLink("notes.txt", { size: 1, contentType: "text/plain" })))
      .mockResolvedValueOnce(new Response("Expired", { status: 403 }))
      .mockResolvedValueOnce(Response.json(readLink("notes.txt", { size: 1, contentType: "text/plain", url: "https://files.example.test/refreshed" })))
      .mockResolvedValueOnce(new Response("Expired", { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    await expect(createWorkspaceFileSource("workspace").read("notes.txt")).rejects.toThrow("Failed to load file: 403");
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls[3][0]).toBe("https://files.example.test/refreshed");
  });
});

it.each([
  { path: "different.mp4" }, { path: undefined },
  { expiresAt: "invalid" }, { expiresAt: undefined },
  { expiresIn: 0 }, { expiresIn: -1 }, { expiresIn: undefined },
])("rejects an incomplete or mismatched descriptor: %j", async (invalid) => {
  const fetch = vi.fn().mockResolvedValue(Response.json(readLink("film.mp4", invalid)));
  vi.stubGlobal("fetch", fetch);
  await expect(createWorkspaceFileSource("workspace").read("film.mp4")).rejects.toThrow("The file link response is incomplete");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("reclassifies a changed object when refreshing an expired text link", async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json(readLink("notes", { size: 100, contentType: "text/plain" })))
    .mockResolvedValueOnce(new Response("Expired", { status: 403 }))
    .mockResolvedValueOnce(Response.json(readLink("notes", { size: 100, contentType: "image/png" })));
  vi.stubGlobal("fetch", fetch);
  await expect(createWorkspaceFileSource("workspace").read("notes")).resolves.toMatchObject({ contentType: "image/png", text: null, isBinary: true });
  expect(fetch).toHaveBeenCalledTimes(3);
});
