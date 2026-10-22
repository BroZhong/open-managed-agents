// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSkillFileSource, methodsOf, resolveFilePresentation } from "./file-source";

/** A TrueType header followed by bytes that are not valid UTF-8. */
const TTF = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0xff, 0xfe, 0xc3, 0x28, 0x80, 0x00, 0x10]);

let objectUrls: Map<string, Blob>;
let revoked: string[];

beforeEach(() => {
  objectUrls = new Map();
  revoked = [];
  // jsdom implements neither; the source must create and revoke its own URLs.
  Object.assign(URL, {
    createObjectURL: vi.fn((blob: Blob) => {
      const url = `blob:skill/${objectUrls.size + 1}`;
      objectUrls.set(url, blob);
      return url;
    }),
    revokeObjectURL: vi.fn((url: string) => { revoked.push(url); }),
  });
  localStorage.setItem("oma_api_key", "api-secret");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
const url = (call: unknown[]) => new URL(String(call[0]), "http://localhost");

describe("SkillFileSource", () => {
  it("previews and downloads media and edits text, like the Workspace", () => {
    const source = createSkillFileSource("skill_123");
    expect(source.capabilities).toEqual({ hierarchy: "nested", idleGated: false });
    expect(methodsOf(source)).toEqual({ write: true, rename: true, delete: true, upload: true, previewUrl: true });
    expect(typeof source.downloadUrl).toBe("function");
  });

  it("reads text for the editor and a binary file as metadata only", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ path: "SKILL.md", content: "# Fonts" }))
      .mockResolvedValueOnce(Response.json({ path: "assets/Regular.ttf", binary: true, size: 11, contentType: "font/ttf" }))
      .mockResolvedValueOnce(Response.json({ path: "assets/logo.png", binary: true, size: 68, contentType: "image/png" }));
    vi.stubGlobal("fetch", fetch);
    const source = createSkillFileSource("skill_123");

    const text = await source.read("SKILL.md");
    expect(text).toMatchObject({ path: "SKILL.md", text: "# Fonts", isBinary: false });
    expect(resolveFilePresentation(text, "preview")).toBe("text");

    const font = await source.read("assets/Regular.ttf");
    expect(font).toEqual({ path: "assets/Regular.ttf", text: null, contentType: "font/ttf", size: 11, isBinary: true });
    expect(resolveFilePresentation(font, "preview")).toBe("download");

    const image = await source.read("assets/logo.png");
    expect(image).toMatchObject({ text: null, isBinary: true, contentType: "image/png" });
    expect(resolveFilePresentation(image, "preview")).toBe("image");

    expect(fetch.mock.calls.map((call) => url(call).pathname + url(call).search)).toEqual([
      "/v1/skills/skill_123/files/content?path=SKILL.md",
      "/v1/skills/skill_123/files/content?path=assets%2FRegular.ttf",
      "/v1/skills/skill_123/files/content?path=assets%2Flogo.png",
    ]);
  });

  it("uploads the files' exact bytes as one multipart request", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ data: [{ path: "assets/Regular.ttf" }] }));
    vi.stubGlobal("fetch", fetch);
    const onChanged = vi.fn();
    const source = createSkillFileSource("skill_123", onChanged);

    await source.upload!([new File([TTF], "Regular.ttf", { type: "font/ttf" }), new File(["# notes"], "notes.md")], "assets");

    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = fetch.mock.calls[0];
    expect(url(fetch.mock.calls[0]).pathname).toBe("/v1/skills/skill_123/files/upload");
    expect(init).toMatchObject({ method: "POST", headers: { Authorization: "Bearer api-secret" } });
    const form = init.body as FormData;
    expect(form.get("destDir")).toBe("assets");
    const files = form.getAll("files") as File[];
    expect(files.map((file) => file.name)).toEqual(["Regular.ttf", "notes.md"]);
    expect(await bytesOf(files[0])).toEqual(TTF);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("keeps saving text through the text PUT", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ path: "notes.md", content: "edited" }));
    vi.stubGlobal("fetch", fetch);
    await createSkillFileSource("skill_123").write!("notes.md", "edited");
    expect(url(fetch.mock.calls[0]).pathname).toBe("/v1/skills/skill_123/files/content");
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "PUT", body: JSON.stringify({ path: "notes.md", content: "edited" }) });
  });

  it("previews bytes fetched with the API credential through one object URL at a time", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(TTF, { headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetch);
    const source = createSkillFileSource("skill_123");

    const first = await source.previewUrl!("assets/logo.png");
    expect(url(fetch.mock.calls[0]).pathname + url(fetch.mock.calls[0]).search)
      .toBe("/v1/skills/skill_123/files/raw?path=assets%2Flogo.png");
    expect(fetch.mock.calls[0][1]).toMatchObject({ headers: { Authorization: "Bearer api-secret" } });
    expect(await bytesOf(objectUrls.get(first)!)).toEqual(TTF);
    expect(objectUrls.get(first)!.type).toBe("image/png");

    const second = await source.previewUrl!("assets/logo.png", { forceRefresh: true });
    expect(second).not.toBe(first);
    expect(revoked).toEqual([first]);
    source.dispose();
    expect(revoked).toEqual([first, second]);
  });

  it("creates no URL for a preview that was cancelled", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => {
      controller.abort();
      return new Response(TTF);
    }));
    await expect(createSkillFileSource("skill_123").previewUrl!("a.png", { signal: controller.signal })).rejects.toThrow();
    expect(objectUrls.size).toBe(0);
  });

  it("downloads exact bytes through a short-lived object URL", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(TTF, { headers: { "content-type": "font/ttf" } })));
    const source = createSkillFileSource("skill_123");
    const download = await source.downloadUrl!("assets/Regular.ttf");
    expect(await bytesOf(objectUrls.get(download)!)).toEqual(TTF);
    expect(revoked).toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(revoked).toEqual([download]);
  });

  it("reports a failed byte fetch with the API error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Not found" }, { status: 404 })));
    await expect(createSkillFileSource("skill_123").downloadUrl!("missing.ttf")).rejects.toThrow("Not found");
    expect(objectUrls.size).toBe(0);
  });
});
