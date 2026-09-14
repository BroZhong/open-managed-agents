// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceFileSource } from "./file-source";

afterEach(() => vi.unstubAllGlobals());

describe("Workspace file list responses", () => {
  it("treats an incomplete successful response as unconfirmed, not an empty Workspace", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({})));
    await expect(createWorkspaceFileSource("session").list()).rejects.toThrow("File status is unconfirmed");
  });

  it("accepts a confirmed empty Workspace and propagates storage failures", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [] }))
      .mockResolvedValueOnce(Response.json({ error: "Workspace storage is unavailable" }, { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const source = createWorkspaceFileSource("session");
    await expect(source.list()).resolves.toEqual([]);
    await expect(source.list()).rejects.toThrow("Workspace storage is unavailable");
  });
});
