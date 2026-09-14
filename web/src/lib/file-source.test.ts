import { afterEach, describe, it, expect, vi } from "vitest";
import {
  classifyMedia,
  resolveFilePresentation,
  resolveFileActions,
  methodsOf,
  createSkillFileSource,
  createWorkspaceFileSource,
  createAgentFileSource,
  WRITE_LOCKED_REASON,
  type FileSourceCapabilities,
  type MethodsPresent,
} from "./file-source";

// ── resolveFileActions ────────────────────────────────────────────────────────

const NESTED_GATED: FileSourceCapabilities = { hierarchy: "nested", idleGated: true };
const NESTED_UNGATED: FileSourceCapabilities = { hierarchy: "nested", idleGated: false };
const FLAT: FileSourceCapabilities = { hierarchy: "flat", idleGated: false };

const ALL_METHODS: MethodsPresent = {
  write: true,
  rename: true,
  delete: true,
  upload: true,
  previewUrl: true,
};
const NO_METHODS: MethodsPresent = {
  write: false,
  rename: false,
  delete: false,
  upload: false,
  previewUrl: false,
};

describe("resolveFileActions", () => {
  it("gives writable actions when the write method is present", () => {
    const a = resolveFileActions(NESTED_UNGATED, ALL_METHODS, "idle");
    expect(a.canSave).toBe(true);
    expect(a.canCreate).toBe(true);
    expect(a.canRename).toBe(true);
    expect(a.canDelete).toBe(true);
    expect(a.canUpload).toBe(true);
    expect(a.writeDisabledReason).toBeNull();
  });

  it("withholds writable actions on a read-only domain", () => {
    const a = resolveFileActions(NESTED_UNGATED, NO_METHODS, "idle");
    expect(a.canSave).toBe(false);
    expect(a.canCreate).toBe(false);
    expect(a.canRename).toBe(false);
    expect(a.canDelete).toBe(false);
    expect(a.canUpload).toBe(false);
  });

  it("reflects a partial method set (write without rename/upload — Agent Files shape)", () => {
    const methods: MethodsPresent = {
      write: true,
      rename: false,
      delete: true,
      upload: false,
      previewUrl: false,
    };
    const a = resolveFileActions(FLAT, methods, "idle");
    expect(a.canSave).toBe(true);
    expect(a.canCreate).toBe(false);
    expect(a.canDelete).toBe(true);
    expect(a.canRename).toBe(false);
    expect(a.canUpload).toBe(false);
  });

  it("disables writes with a reason when idle-gated and the turn is running", () => {
    const a = resolveFileActions(NESTED_GATED, ALL_METHODS, "running");
    expect(a.canSave).toBe(true); // action still shown…
    expect(a.writeDisabledReason).toBe(WRITE_LOCKED_REASON); // …but disabled with a reason
  });

  it("allows writes when idle-gated but the turn is idle", () => {
    const a = resolveFileActions(NESTED_GATED, ALL_METHODS, "idle");
    expect(a.writeDisabledReason).toBeNull();
  });

  it("never disables writes on a non-idle-gated domain even while running", () => {
    const a = resolveFileActions(NESTED_UNGATED, ALL_METHODS, "running");
    expect(a.writeDisabledReason).toBeNull();
  });

  it("falls back to download when there is no previewUrl", () => {
    const a = resolveFileActions(NESTED_GATED, { ...ALL_METHODS, previewUrl: false }, "idle");
    expect(a.mediaMode).toBe("download");
  });

  it("previews media when previewUrl is present", () => {
    const a = resolveFileActions(NESTED_GATED, ALL_METHODS, "idle");
    expect(a.mediaMode).toBe("preview");
  });

  it("shows directory affordances on nested sources", () => {
    const a = resolveFileActions(NESTED_UNGATED, ALL_METHODS, "idle");
    expect(a.showDirs).toBe(true);
    expect(a.allowSubdirs).toBe(true);
  });

  it("hides directory affordances on flat sources", () => {
    const a = resolveFileActions(FLAT, ALL_METHODS, "idle");
    expect(a.showDirs).toBe(false);
    expect(a.allowSubdirs).toBe(false);
  });
});

// ── File presentation (content availability + media capability) ─────────────

describe("resolveFilePresentation", () => {
  it("downloads oversized text whose body was intentionally not loaded", () => {
    expect(
      resolveFilePresentation(
        {
          path: "reports/large.md",
          text: null,
          contentType: "text/markdown",
          size: 600 * 1024,
          isBinary: true,
        },
        "preview",
      ),
    ).toBe("download");
  });

  it("renders only loaded text as text", () => {
    expect(
      resolveFilePresentation(
        {
          path: "notes.md",
          text: "hello",
          contentType: "text/markdown",
          size: 5,
          isBinary: false,
        },
        "preview",
      ),
    ).toBe("text");
  });

  it("previews known image kinds and honors download-only sources", () => {
    const image = {
      path: "cover.png",
      text: null,
      contentType: "application/octet-stream",
      size: 10,
      isBinary: true,
    };
    expect(resolveFilePresentation(image, "preview")).toBe("image");
    expect(resolveFilePresentation(image, "download")).toBe("download");
  });

  it("previews audio only when the source can provide a preview URL", () => {
    const audio = {
      path: "voice.mp3",
      text: null,
      contentType: "application/octet-stream",
      size: 1024,
      isBinary: true,
    };
    expect(resolveFilePresentation(audio, "preview")).toBe("audio");
    expect(resolveFilePresentation(audio, "download")).toBe("download");
    expect(resolveFilePresentation(audio, "none")).toBe("download");
  });
});

// ── classifyMedia (extension-first, MIME fallback) ─────────────────────────────

describe("classifyMedia", () => {
  it("prefers the extension over MIME (.png with octet-stream is still an image)", () => {
    expect(classifyMedia("report/cover.png", "application/octet-stream")).toBe("image");
  });

  it("classifies video by extension regardless of MIME", () => {
    expect(classifyMedia("clip.mp4", "application/x-www-form-urlencoded")).toBe("video");
  });

  it.each(["mp3", "wav", "m4a", "m4b", "weba", "aac", "ogg", "oga", "opus", "flac", "aif", "aiff", "MP3"])(
    "classifies .%s audio even when its stored MIME is generic or incorrect",
    (extension) => {
      expect(classifyMedia(`audio/voice.${extension}`, "application/octet-stream")).toBe("audio");
      expect(classifyMedia(`audio/voice.${extension}`, "text/plain")).toBe("audio");
    },
  );

  it("falls back to MIME when there is no extension", () => {
    expect(classifyMedia("screenshot", "image/png")).toBe("image");
    expect(classifyMedia("recording", "video/mp4")).toBe("video");
    expect(classifyMedia("voice", "audio/mpeg")).toBe("audio");
  });

  it("uses audio MIME for unknown extensions while preserving known file types", () => {
    expect(classifyMedia("voice.recording", "audio/webm")).toBe("audio");
    expect(classifyMedia("notes.md", "audio/mp4")).toBe("text");
    expect(classifyMedia("cover.png", "audio/mp4")).toBe("image");
    expect(classifyMedia("clip.mp4", "audio/mp4")).toBe("video");
  });

  it("treats known text extensions as text", () => {
    expect(classifyMedia("notes.md", "application/octet-stream")).toBe("text");
    expect(classifyMedia("data.json", "text/plain")).toBe("text");
  });

  it("treats text/* MIME as text", () => {
    expect(classifyMedia("weirdname", "text/plain")).toBe("text");
  });

  it("classifies an unknown binary as binary", () => {
    expect(classifyMedia("archive.zip", "application/zip")).toBe("binary");
    expect(classifyMedia("blob", "application/octet-stream")).toBe("binary");
  });
});

// ── FileSource capability matrix (method presence == capability) ───────────────

describe("SkillFileSource", () => {
  const s = createSkillFileSource("skill_123");
  it("has nested, non-idle-gated capabilities", () => {
    expect(s.capabilities).toEqual({ hierarchy: "nested", idleGated: false });
  });
  it("exposes write/rename/delete/upload but no previewUrl", () => {
    expect(methodsOf(s)).toEqual({
      write: true,
      rename: true,
      delete: true,
      upload: true,
      previewUrl: false,
    });
  });
});

describe("WorkspaceFileSource", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const s = createWorkspaceFileSource("sess_123");
  it("has nested, idle-gated capabilities", () => {
    expect(s.capabilities).toEqual({ hierarchy: "nested", idleGated: true });
  });
  it("exposes the full method set including previewUrl", () => {
    expect(methodsOf(s)).toEqual({
      write: true,
      rename: true,
      delete: true,
      upload: true,
      previewUrl: true,
    });
  });

  it.each([
    { name: "non-empty", bytes: Uint8Array.from([0x00, 0xff, 0x80, 0x01]) },
    { name: "empty", bytes: new Uint8Array() },
  ])("reads the actual size of a $name binary without Content-Length", async ({ bytes }) => {
    const response = new Response(bytes, { headers: { "content-type": "audio/wav" } });
    expect(response.headers.has("content-length")).toBe(false);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    vi.stubGlobal("localStorage", { getItem: () => "test-token" });

    expect(await s.read("voice.wav")).toEqual({
      path: "voice.wav",
      text: null,
      contentType: "audio/wav",
      size: bytes.byteLength,
      isBinary: true,
    });
  });

  it.each([
    ["voice.mp3", "application/octet-stream", "audio/mpeg"],
    ["voice.M4A", "text/plain", "audio/mp4"],
    ["voice.m4b", "application/octet-stream", "audio/mp4"],
    ["voice.weba", "application/octet-stream", "audio/webm"],
    ["voice.ogg", "audio/ogg; codecs=opus", "audio/ogg;codecs=opus"],
  ])("previews %s with an audio Blob MIME and unchanged bytes", async (path, storedType, expectedType) => {
    const bytes = Uint8Array.from([0x00, 0xff, 0x80, 0x01]);
    const fetchFile = vi.fn().mockResolvedValue(new Response(bytes, {
      headers: { "content-type": storedType },
    }));
    vi.stubGlobal("fetch", fetchFile);
    vi.stubGlobal("localStorage", { getItem: () => "test-token" });
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:audio");

    expect(await s.previewUrl!(path)).toBe("blob:audio");
    expect(fetchFile).toHaveBeenCalledWith(expect.stringContaining(path), {
      headers: { Authorization: "Bearer test-token" },
    });
    const blob = createObjectURL.mock.calls[0][0];
    if (!(blob instanceof Blob)) throw new Error("Expected a preview Blob");
    expect(blob.type).toBe(expectedType);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  });
});

describe("AgentFileSource", () => {
  const s = createAgentFileSource("agent_123");
  it("has flat, non-idle-gated capabilities", () => {
    expect(s.capabilities).toEqual({ hierarchy: "flat", idleGated: false });
  });
  it("exposes write/delete only — no rename, no upload, no previewUrl", () => {
    expect(methodsOf(s)).toEqual({
      write: true,
      rename: false,
      delete: true,
      upload: false,
      previewUrl: false,
    });
  });
  it("lists exactly the fixed four names in prompt-assembly order", async () => {
    const nodes = await s.list();
    expect(nodes.map((n) => n.path)).toEqual(["IDENTITY", "SOUL", "USER", "MEMORY"]);
    expect(nodes.every((n) => !n.isDir)).toBe(true);
  });
});
