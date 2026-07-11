import { describe, it, expect } from "vitest";
import {
  classifyMedia,
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
    expect(a.canRename).toBe(true);
    expect(a.canDelete).toBe(true);
    expect(a.canUpload).toBe(true);
    expect(a.writeDisabledReason).toBeNull();
  });

  it("withholds writable actions on a read-only domain", () => {
    const a = resolveFileActions(NESTED_UNGATED, NO_METHODS, "idle");
    expect(a.canSave).toBe(false);
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

// ── classifyMedia (extension-first, MIME fallback) ─────────────────────────────

describe("classifyMedia", () => {
  it("prefers the extension over MIME (.png with octet-stream is still an image)", () => {
    expect(classifyMedia("report/cover.png", "application/octet-stream")).toBe("image");
  });

  it("classifies video by extension regardless of MIME", () => {
    expect(classifyMedia("clip.mp4", "application/x-www-form-urlencoded")).toBe("video");
  });

  it("falls back to MIME when there is no extension", () => {
    expect(classifyMedia("screenshot", "image/png")).toBe("image");
    expect(classifyMedia("recording", "video/mp4")).toBe("video");
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
