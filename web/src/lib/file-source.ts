/**
 * FileSource — the frontend abstraction the unified file editor/preview
 * component consumes (issue #90, design doc `docs/design/unified-file-component.md`).
 *
 * The component does NOT know whether it is editing a Skill, a Workspace, or an
 * Agent's Files. It knows only a FileSource: "list me the tree, read me a file,
 * (maybe) let me write/rename/delete/upload, (maybe) hand me a signed preview
 * URL." The three domains are three implementations — `SkillFileSource`,
 * `WorkspaceFileSource`, `AgentFileSource` — each using its domain API.
 *
 * NAMING: this is deliberately *not* called `Adapter`. The backend `Adapter`
 * (ADR-0002 — translates events into the Pi SDK) is an unrelated concept; reusing
 * the word here would be a domain collision. This is a **FileSource**.
 *
 * SHAPE: `list` / `read` / `capabilities` are the required core (all three
 * domains have them). `write` / `rename` / `delete` / `upload` / `previewUrl`
 * are OPTIONAL — **the presence of a method IS the capability**. A domain that
 * cannot rename simply omits `rename`; TypeScript then makes `source.rename`
 * `undefined`, so a miswired call fails to compile. Non-method traits that can't
 * be expressed as "method present?" live in {@link FileSourceCapabilities}.
 *
 * Concrete implementations below wrap each domain's authenticated Host API.
 */

/** A node in a FileSource's tree. Flat sources only ever emit files at depth 1. */
export interface FileNode {
  /** Source-relative path (e.g. `report/cover.png`, or a fixed name like `IDENTITY` when flat). */
  path: string;
  /** Directory vs file. Flat sources never emit `isDir: true`. */
  isDir: boolean;
  size?: number;
  updatedAt?: string;
}

/**
 * The result of {@link FileSource.read}. Text is returned inline for the editor;
 * binary content is NOT returned as a body — its bytes are fetched via
 * {@link FileSource.previewUrl} (a signed GET) or downloaded, never inlined.
 */
export interface FileContent {
  path: string;
  /** Text body when previewable as text (and within the size cap), else null. */
  text: string | null;
  contentType: string;
  size: number;
  /** True when the content is binary — render via previewUrl / download, not inline. */
  isBinary: boolean;
}

/**
 * Non-method traits of a FileSource — the things the component needs that
 * "does this method exist?" cannot express.
 *
 * Deliberately NOT here (each is carried by a method's presence instead):
 *  - `canWrite` → carried by `write?`
 *  - media support → carried by `previewUrl?`
 */
export interface FileSourceCapabilities {
  /**
   * `flat` — a single-level set of files, no subdirectories (Agent Files: a
   * fixed set of named markdown docs — IDENTITY / SOUL / USER / MEMORY — the
   * Host assembles into the runtime prompt in that fixed order).
   * `nested` — arbitrary user-created paths at any depth (Skill, Workspace).
   */
  hierarchy: "flat" | "nested";

  /**
   * Optional UI rule for sources that require an idle Turn. Current Skill,
   * Agent and Workspace sources all set this to false. Workspace writes are
   * independent of Session execution (ADR-0009).
   */
  idleGated: boolean;
}

/** Optional request cancellation and explicit signed-link refresh. */
export interface FileReadOptions {
  signal?: AbortSignal;
  /** Bypass a recently signed preview link after an expiry or media failure. */
  forceRefresh?: boolean;
}

/** Required file operations plus optional editing, preview, and download capabilities. */
export interface FileSource {
  // ── required core (all three domains) ──────────────────────────────────────

  /** List the file tree (flat sources return depth-1 files only). */
  list(): Promise<FileNode[]>;
  /** Read one file: text body for the editor, or binary metadata (see previewUrl). */
  read(path: string, options?: FileReadOptions): Promise<FileContent>;
  /** Static traits driving the UI (see {@link FileSourceCapabilities}). */
  readonly capabilities: FileSourceCapabilities;

  // ── optional capability methods (presence = capability) ─────────────────────

  /** Present ⇒ writable. Save a text file's content. */
  write?(path: string, content: string): Promise<void>;
  /** Persist an empty directory on sources that support it. */
  createDirectory?(path: string): Promise<void>;
  /** Present ⇒ renamable. Move `from` → `to` (both source-relative). */
  rename?(from: string, to: string): Promise<void>;
  /** Present ⇒ deletable. Remove a file. */
  delete?(path: string): Promise<void>;
  /**
   * Present ⇒ accepts uploads INTO this source (media, binaries, batches).
   * Semantics are "put these bytes into this container" — NOT the Skill Library's
   * "upload a folder to create a new Skill", which stays in the Library UI.
   * `destDir` targets a subdir on nested sources; ignored on flat.
   */
  upload?(files: File[], destDir?: string): Promise<void>;
  /**
   * Present ⇒ media-previewable. Return a short-lived signed GET URL for direct
   * object-store read (images/video), bypassing the Host proxy (ADR-0006 §1, #88). Writes
   * are NEVER presigned — only this downward read is.
   */
  previewUrl?(path: string, options?: FileReadOptions): Promise<string>;
  /** Request a fresh signed attachment URL for a browser-native download. */
  downloadUrl?(path: string, options?: FileReadOptions): Promise<string>;
}

// ─── the three domain implementations ─────────────────────────────────────────
//
// These plain objects expose each domain's authenticated API without React.
// Workspace bytes use signed object-store URLs; metadata and writes use the Host.

import { apiFetch, apiUpload } from "@/lib/api";
import { encodePath } from "@/lib/workspace-tree";
import { AGENT_FILE_NAMES } from "@/lib/hooks/use-agent-files";

// ── Skill ─────────────────────────────────────────────────────────────────────

/**
 * Skill (Library Skill or Agent's Skill Fork — same component, different id;
 * ADR-0004). Nested, fully writable, uploads attachments into the Skill, no
 * media preview (Skills are text). Wraps the `/v1/skills/:id/files` routes
 * (same paths as `use-skills.ts`).
 *
 * The Library-Skill vs Skill-Fork distinction is *only* the `skillId` passed to
 * the constructor — both hit the same routes.
 */
export type SkillFileSource = FileSource & {
  capabilities: { hierarchy: "nested"; idleGated: false };
};

export function createSkillFileSource(skillId: string, onChanged?: () => void): SkillFileSource {
  const base = `/v1/skills/${skillId}/files`;
  return {
    capabilities: { hierarchy: "nested", idleGated: false },

    async list(): Promise<FileNode[]> {
      const res = await apiFetch<{ data: string[] }>(base);
      return res.data.map((path) => ({ path, isDir: false }));
    },

    async read(path: string): Promise<FileContent> {
      const res = await apiFetch<{ path: string; content: string }>(
        `${base}/content?path=${encodeURIComponent(path)}`,
      );
      // Skills are text-only; there is no binary path here.
      return {
        path: res.path,
        text: res.content,
        contentType: "text/plain",
        size: res.content.length,
        isBinary: false,
      };
    },

    async write(path: string, content: string): Promise<void> {
      await apiFetch(`${base}/content`, {
        method: "PUT",
        body: JSON.stringify({ path, content }),
      });
      onChanged?.();
    },

    async rename(from: string, to: string): Promise<void> {
      await apiFetch(`${base}/rename`, {
        method: "POST",
        body: JSON.stringify({ from, to }),
      });
      onChanged?.();
    },

    async delete(path: string): Promise<void> {
      await apiFetch(`${base}/content?path=${encodeURIComponent(path)}`, {
        method: "DELETE",
      });
      onChanged?.();
    },

    async upload(files: File[], destDir?: string): Promise<void> {
      // Attachments INTO this Skill — one PUT per file (the Skill file routes
      // are single-file; there is no batch endpoint). This is NOT the Library's
      // "upload a folder to create a Skill" (useUploadSkills), which stays out.
      //
      // TEXT-ONLY: the Skill content route (`PUT …/files/content`) takes a JSON
      // `{ path, content: string }`, so bytes go through `file.text()`. Skills
      // are a text domain (no previewUrl); binary attachments would be mangled.
      // Uploading arbitrary binaries into a Skill needs a multipart Skill route
      // that does not exist yet — see #91 (deliberately out of scope this pass).
      for (const file of files) {
        const path = joinDest(destDir, file.name);
        const content = await file.text();
        await apiFetch(`${base}/content`, {
          method: "PUT",
          body: JSON.stringify({ path, content }),
        });
        onChanged?.();
      }
    },
    // No previewUrl: Skills are text.
  };
}

// ── Workspace ───────────────────────────────────────────────────────────────

/**
 * Tenant-owned Workspace files. Nested, writable during Turns and accessible
 * without a Session (ADR-0009). The Host authorizes reads and signs OSS URLs;
 * clients fetch content directly from storage. Inline text is capped at 512 KiB.
 */
export type WorkspaceFileSource = FileSource & {
  capabilities: { hierarchy: "nested"; idleGated: false };
};

const WS_TEXT_LIKE = /^(text\/|application\/(json|javascript|xml|x-yaml|yaml)|image\/svg)/;
const WORKSPACE_DIRECTORY_MARKER = "/.oma-directory";
const WS_MAX_TEXT_PREVIEW = 512 * 1024;
const WORKSPACE_READ_TIMEOUT_MS = 30_000;

interface WorkspaceReadLink {
  path: string;
  url: string;
  expiresIn: number;
  expiresAt: string;
  size: number;
  contentType: string;
  etag?: string;
}

function readSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(WORKSPACE_READ_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Stop reading immediately if a changed object exceeds the inline-preview cap. */
async function readBoundedText(response: Response): Promise<string | null> {
  const declaredSize = Number(response.headers.get("content-length"));
  if (declaredSize > WS_MAX_TEXT_PREVIEW) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > WS_MAX_TEXT_PREVIEW) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function createWorkspaceReader(workspaceId: string, access: {
  json<T>(path: string, options?: { signal?: AbortSignal; cache?: RequestCache }): Promise<T>;
}): WorkspaceFileSource {
  const apiPath = `/v1/workspaces/${encodeURIComponent(workspaceId)}`;
  // Reuse metadata between read() and the initial media mount only. Fresh
  // selections and explicit refreshes always reauthorize and HEAD the object.
  let recentLink: { link: WorkspaceReadLink; acquiredAt: number } | undefined;

  async function getLink(path: string, options: FileReadOptions = {}, download = false): Promise<WorkspaceReadLink> {
    options.signal?.throwIfAborted();
    if (!download && !options.forceRefresh && recentLink?.link.path === path
      && Date.now() - recentLink.acquiredAt < 10_000
      && Date.parse(recentLink.link.expiresAt) > Date.now() + 30_000) {
      return recentLink.link;
    }
    const link = await access.json<WorkspaceReadLink>(
      `${apiPath}/files/${encodePath(path)}${download ? "?download=1" : ""}`,
      { signal: readSignal(options.signal), cache: "no-store" },
    );
    if (!link || link.path !== path || typeof link.url !== "string" || !/^https?:\/\//.test(link.url)
      || !Number.isSafeInteger(link.size) || link.size < 0 || typeof link.contentType !== "string" || !link.contentType
      || !Number.isFinite(link.expiresIn) || link.expiresIn <= 0
      || typeof link.expiresAt !== "string" || !Number.isFinite(Date.parse(link.expiresAt))) {
      throw new Error("The file link response is incomplete. Refresh to retry.");
    }
    options.signal?.throwIfAborted();
    if (!download) recentLink = { link, acquiredAt: Date.now() };
    return link;
  }

  return {
    capabilities: { hierarchy: "nested", idleGated: false },

    async list(): Promise<FileNode[]> {
      const res = await access.json<{ data: WorkspaceFileEntry[] }>(`${apiPath}/files`);
      if (!Array.isArray(res?.data)) {
        throw new Error("File status is unconfirmed: the Workspace list response is incomplete. Retry Refresh.");
      }
      const nodes = res.data.map((f) => ({
        // A reserved, empty marker preserves empty directories in object storage.
        path: (f.path.endsWith(WORKSPACE_DIRECTORY_MARKER) && f.size === 0 ? f.path.slice(0, -WORKSPACE_DIRECTORY_MARKER.length) : f.path).replace(/\/+$/, ""),
        isDir: f.isDir === true || f.path.endsWith("/") || (f.path.endsWith(WORKSPACE_DIRECTORY_MARKER) && f.size === 0),
        size: f.size,
        updatedAt: f.updated_at ?? undefined,
      }));
      // Some storage listings include a folder entry without a directory flag.
      return nodes.map((node) => ({ ...node, isDir: node.isDir || nodes.some((child) => child.path.startsWith(`${node.path}/`)) }));
    },

    async read(path: string, options: FileReadOptions = {}): Promise<FileContent> {
      let link = await getLink(path, { ...options, forceRefresh: true });
      for (let attempt = 0; ; attempt++) {
        const { contentType, size } = link;
        const kind = classifyMedia(path, contentType);
        const isMedia = kind === "image" || kind === "video" || kind === "audio";
        const isText = !isMedia && (WS_TEXT_LIKE.test(contentType) || isTextByExtension(path));
        if (!isText || size > WS_MAX_TEXT_PREVIEW) {
          return { path, text: null, contentType, size, isBinary: true };
        }
        // Storage URLs carry their own temporary credential. Never forward the
        // application's Authorization header or cookies to the object host.
        const response = await fetch(link.url, {
          signal: readSignal(options.signal), credentials: "omit", cache: "no-store",
        });
        if (response.status === 403 && attempt === 0) {
          await response.body?.cancel();
          link = await getLink(path, { ...options, forceRefresh: true });
          // A path may be overwritten while a link expires. Reclassify its
          // fresh metadata before requesting another body.
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`Failed to load file: ${response.status}`);
        }
        const text = await readBoundedText(response);
        return { path, text, contentType, size, isBinary: text === null };
      }
    },

    async previewUrl(path: string, options?: FileReadOptions): Promise<string> {
      return (await getLink(path, options)).url;
    },

    async downloadUrl(path: string, options?: FileReadOptions): Promise<string> {
      return (await getLink(path, options, true)).url;
    },
  };
}

export function createSharedWorkspaceFileSource(workspaceId: string, access: import("./share-api").ShareAccess): WorkspaceFileSource {
  return createWorkspaceReader(workspaceId, access);
}

export function createWorkspaceFileSource(workspaceId: string): WorkspaceFileSource {
  const apiPath = `/v1/workspaces/${encodeURIComponent(workspaceId)}`;
  return {
    ...createWorkspaceReader(workspaceId, { json: apiFetch }),
    async write(path: string, content: string): Promise<void> {
      await apiFetch(`${apiPath}/files/content`, {
        method: "PUT",
        body: JSON.stringify({ path, content }),
      });
    },

    async createDirectory(path: string): Promise<void> {
      await apiFetch(`${apiPath}/files/content`, {
        method: "PUT",
        body: JSON.stringify({ path: `${path}${WORKSPACE_DIRECTORY_MARKER}`, content: "" }),
      });
    },

    async rename(from: string, to: string): Promise<void> {
      await apiFetch(`${apiPath}/files/rename`, {
        method: "POST",
        body: JSON.stringify({ from, to }),
      });
    },

    async delete(path: string): Promise<void> {
      await apiFetch(`${apiPath}/files/content?path=${encodeURIComponent(path)}`, {
        method: "DELETE",
      });
    },

    async upload(files: File[], destDir?: string): Promise<void> {
      const form = new FormData();
      if (destDir) form.set("destDir", destDir);
      for (const file of files) form.append("files", file, file.name);
      await apiUpload(`${apiPath}/files/upload`, form);
    },

  };
}

interface WorkspaceFileEntry {
  path: string;
  isDir?: boolean;
  size: number;
  updated_at: string | null;
}

// ── Agent Files ───────────────────────────────────────────────────────────────

/**
 * Agent Files (a FIXED set of named markdown docs — IDENTITY / SOUL / USER /
 * MEMORY — assembled into the prompt in that order). Flat and writable, but the
 * name set is closed: **no `rename`** (names are fixed), **no `upload`**
 * (markdown only), no media preview. `list` returns the fixed set; `delete`
 * clears a file back to empty. Wraps the `/v1/agents/:id/files` routes.
 */
export type AgentFileSource = FileSource & {
  capabilities: { hierarchy: "flat"; idleGated: false };
};

export function createAgentFileSource(agentId: string): AgentFileSource {
  const base = `/v1/agents/${agentId}/files`;

  async function readOne(filename: string): Promise<AgentFileResponse> {
    try {
      return await apiFetch<AgentFileResponse>(`${base}/${filename}`);
    } catch {
      // A file never saved reads as an empty document (mirrors use-agent-files).
      return { filename, content: "", updatedAt: "" };
    }
  }

  return {
    capabilities: { hierarchy: "flat", idleGated: false },

    async list(): Promise<FileNode[]> {
      // The closed set of four names, in prompt-assembly order.
      return AGENT_FILE_NAMES.map((name) => ({ path: name, isDir: false }));
    },

    async read(path: string): Promise<FileContent> {
      const res = await readOne(path);
      return {
        path: res.filename,
        text: res.content,
        contentType: "text/markdown",
        size: res.content.length,
        isBinary: false,
      };
    },

    async write(path: string, content: string): Promise<void> {
      await apiFetch(`${base}/${path}`, {
        method: "POST",
        body: JSON.stringify({ content }),
      });
    },

    async delete(path: string): Promise<void> {
      // Names are fixed; "delete" clears the doc back to empty (upsert "").
      await apiFetch(`${base}/${path}`, {
        method: "POST",
        body: JSON.stringify({ content: "" }),
      });
    },
    // No rename (names are fixed), no upload (markdown only), no previewUrl.
  };
}

interface AgentFileResponse {
  filename: string;
  content: string;
  updatedAt: string;
}

// ─── capability → UI: pure decision functions (the testable core) ─────────────

/**
 * Media classification: **extension-first, MIME as a weak fallback** (issue
 * #93). S3 stores whatever MIME was set at write time, which is unreliable for
 * shell-created files, so the extension wins when it is known. MIME is trusted
 * when the extension is absent; audio MIME also identifies unknown extensions.
 */
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"]);
const VIDEO_EXT = new Set(["mp4", "webm", "mov", "m4v", "mkv", "ogv"]);
const AUDIO_MIME_TYPES: Readonly<Record<string, string>> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  m4b: "audio/mp4",
  weba: "audio/webm",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  aif: "audio/aiff",
  aiff: "audio/aiff",
};
const TEXT_EXT = new Set([
  "txt", "md", "markdown", "json", "yaml", "yml", "xml", "csv", "tsv", "log",
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt",
  "c", "h", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "sql", "toml", "ini",
  "cfg", "conf", "env", "html", "css", "scss", "svg", "gitignore", "dockerfile",
]);

export type MediaKind = "image" | "video" | "audio" | "text" | "binary";

function extOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
}

/** True when a workspace path looks like text by its extension (shared with `read`). */
function isTextByExtension(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : name.toLowerCase();
  return TEXT_EXT.has(ext);
}

/**
 * Classify a file as image / video / audio / text / other-binary. Extension takes
 * priority (a `.png` is an image even if S3 reports octet-stream); MIME is the
 * fallback only when the extension is unknown.
 */
export function classifyMedia(path: string, contentType: string): MediaKind {
  const ext = extOf(path);
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (Object.hasOwn(AUDIO_MIME_TYPES, ext)) return "audio";
  if (TEXT_EXT.has(ext)) return "text";
  if (!ext) {
    if (contentType.startsWith("image/")) return "image";
    if (contentType.startsWith("video/")) return "video";
  }
  if (contentType.startsWith("audio/")) return "audio";
  if (/^text\//.test(contentType)) return "text";
  return "binary";
}

/** Whether each optional capability method is present on a FileSource. */
export interface MethodsPresent {
  write: boolean;
  rename: boolean;
  delete: boolean;
  upload: boolean;
  previewUrl: boolean;
}

/** The runtime turn state injected by the host page (from SSE). */
export type TurnStatus = "running" | "idle";

/** How the component should render a selected file's media. */
export type MediaMode = "preview" | "download" | "none";

/**
 * The UI decision computed from a source's static capabilities, which optional
 * methods it exposes, and the injected turn status. Pure — no I/O, no React.
 */
export interface FileActions {
  /** Show a Save action at all (the source can write). */
  canSave: boolean;
  /** Show arbitrary new-file creation. Closed, flat sources cannot add names. */
  canCreate: boolean;
  /** Show a rename action. */
  canRename: boolean;
  /** Show a delete action. */
  canDelete: boolean;
  /** Show an upload action. */
  canUpload: boolean;
  /**
   * When a write-class action exists but is disabled, the reason to show
   * (idle-gated source while the turn is running). `null` ⇒ not disabled.
   */
  writeDisabledReason: string | null;
  /** Show directory affordances (expand/collapse, create-in-subdir). Nested only. */
  showDirs: boolean;
  /** Whether new files may carry a path (subdir). Nested only. */
  allowSubdirs: boolean;
  /** How to present binary media: preview when a signed URL is available, else download. */
  mediaMode: MediaMode;
}

/** Shown when an idle-gated source is disabled mid-turn (aligns with #100 / 423). */
export const WRITE_LOCKED_REASON = "Agent 运行中，稍后可编辑";

/**
 * capability → UI decision (the core testable product of this ticket). Pure.
 *
 * - Writable domain (write present) ⇒ writable actions; else none.
 * - `idleGated && turnStatus === "running"` ⇒ write-class actions disabled with
 *   a reason (aligned with #100's 423 message); idle ⇒ allowed.
 * - No previewUrl ⇒ media falls back to download; present ⇒ media preview.
 * - flat ⇒ no directory affordances / no subdirs; nested ⇒ both.
 */
export function resolveFileActions(
  capabilities: FileSourceCapabilities,
  methods: MethodsPresent,
  turnStatus: TurnStatus,
): FileActions {
  const locked = capabilities.idleGated && turnStatus === "running";
  const writeDisabledReason = locked ? WRITE_LOCKED_REASON : null;
  const nested = capabilities.hierarchy === "nested";

  return {
    canSave: methods.write,
    canCreate: methods.write && nested,
    canRename: methods.rename,
    canDelete: methods.delete,
    canUpload: methods.upload,
    writeDisabledReason,
    showDirs: nested,
    allowSubdirs: nested,
    mediaMode: methods.previewUrl ? "preview" : "download",
  };
}

/** The concrete pane selected after considering both file kind and loaded body. */
export type FilePresentation = "text" | "image" | "video" | "audio" | "download";

/**
 * Decide how a file can actually be rendered, not merely what its extension
 * suggests. Text over the inline-preview cap has `text: null` and
 * `isBinary: true`; it must fall back to download instead of flowing into a
 * media component. Only known image/video/audio kinds may reach media elements.
 */
export function resolveFilePresentation(
  content: FileContent,
  mediaMode: MediaMode,
): FilePresentation {
  const kind = classifyMedia(content.path, content.contentType);
  if (kind === "text") {
    return !content.isBinary && content.text !== null ? "text" : "download";
  }
  if (mediaMode !== "preview") return "download";
  if (kind === "image" || kind === "video" || kind === "audio") return kind;
  return "download";
}

/**
 * Probe a live FileSource for which optional methods it exposes. Convenience so
 * callers can feed a real source into {@link resolveFileActions} (which itself
 * takes plain booleans, for easy testing).
 */
export function methodsOf(source: FileSource): MethodsPresent {
  return {
    write: typeof source.write === "function",
    rename: typeof source.rename === "function",
    delete: typeof source.delete === "function",
    upload: typeof source.upload === "function",
    previewUrl: typeof source.previewUrl === "function",
  };
}

/** Join an optional destination dir with a filename into a source-relative path. */
function joinDest(destDir: string | undefined, name: string): string {
  if (!destDir) return name;
  return `${destDir.replace(/\/+$/, "")}/${name}`;
}
