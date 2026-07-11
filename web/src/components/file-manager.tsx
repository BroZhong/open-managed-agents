import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RefreshCw,
  Download,
  UploadCloud,
  File as FileIcon,
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  FileWarning,
  Image as ImageIcon,
  Film,
  AlertTriangle,
  Pencil,
  Trash2,
  FilePlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TextFileEditor } from "@/components/text-file-editor";
import { buildTree, formatSize, type TreeNode } from "@/lib/workspace-tree";
import {
  classifyMedia,
  methodsOf,
  resolveFileActions,
  type FileActions,
  type FileContent,
  type FileNode,
  type FileSource,
  type MediaKind,
  type TurnStatus,
} from "@/lib/file-source";

/**
 * FileManager — the unified file editor/preview surface (#102, design doc
 * `docs/design/unified-file-component.md`). It is **domain-agnostic**: every UI
 * decision is driven by the injected {@link FileSource} plus the externally
 * supplied `turnStatus`. It never subscribes to SSE and never special-cases
 * Skill / Workspace / Agent — capability → UI goes exclusively through
 * {@link resolveFileActions} and {@link classifyMedia} from `file-source.ts`.
 *
 *  - tree      ← `source.list()`  (nested → buildTree; flat → depth-1 list)
 *  - selection ← `source.read(path)` → `classifyMedia` → text / image / video / binary
 *  - buttons   ← `resolveFileActions(capabilities, methodsOf(source), turnStatus)`
 *  - writes    ← `source.write / rename / delete / upload`
 *  - media     ← `source.previewUrl` (image: large-image opt-in; video: silent re-sign)
 */
export interface FileManagerProps {
  source: FileSource;
  /** Injected by the host page (from its existing SSE). Not subscribed here. */
  turnStatus: TurnStatus;
  /** Bumped by the host on a file-change SSE event / turn end to force a refetch. */
  refreshKey?: number;
  /** Copy shown above the tree when it is empty. */
  emptyHint?: string;
}

// ─── Tree rendering (mirrors workspace-panel's TreeRow visual language) ────────

function TreeRow({
  node,
  depth,
  selectedPath,
  expanded,
  onToggle,
  onSelect,
  onDropFiles,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onDropFiles?: (files: File[], destDir: string) => void;
}) {
  const isOpen = expanded.has(node.path);
  const isSelected = !node.isDir && node.path === selectedPath;
  const kind: MediaKind | null = node.isDir ? null : classifyMedia(node.path, "");

  return (
    <>
      <button
        type="button"
        onClick={() => (node.isDir ? onToggle(node.path) : onSelect(node.path))}
        onDragOver={(e) => {
          if (node.isDir && onDropFiles) e.preventDefault();
        }}
        onDrop={(e) => {
          if (!node.isDir || !onDropFiles) return;
          e.preventDefault();
          e.stopPropagation();
          const files = Array.from(e.dataTransfer.files);
          if (files.length) onDropFiles(files, node.path);
        }}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm transition-colors",
          isSelected
            ? "bg-[var(--color-bg-muted)] text-[var(--color-fg)]"
            : "text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)]",
        )}
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
      >
        {node.isDir ? (
          <>
            {isOpen ? (
              <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-fg-subtle)]" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-fg-subtle)]" />
            )}
            {isOpen ? (
              <FolderOpen className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-fg-subtle)]" />
            ) : (
              <Folder className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-fg-subtle)]" />
            )}
          </>
        ) : (
          <>
            <span className="w-3.5 flex-shrink-0" />
            <TreeKindIcon kind={kind!} />
          </>
        )}
        <span className="flex-1 truncate font-mono text-xs">{node.name}</span>
        {!node.isDir && node.size !== undefined && (
          <span className="flex-shrink-0 text-[10px] text-[var(--color-fg-subtle)]">
            {formatSize(node.size)}
          </span>
        )}
      </button>
      {node.isDir &&
        isOpen &&
        node.children.map((child) => (
          <TreeRow
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            expanded={expanded}
            onToggle={onToggle}
            onSelect={onSelect}
            onDropFiles={onDropFiles}
          />
        ))}
    </>
  );
}

function TreeKindIcon({ kind }: { kind: MediaKind }) {
  const c = "h-3.5 w-3.5 flex-shrink-0 text-[var(--color-fg-subtle)]";
  if (kind === "image") return <ImageIcon className={c} />;
  if (kind === "video") return <Film className={c} />;
  return <FileIcon className={c} />;
}

// ─── Media preview pane (the three boundary states from #93 NOTES) ─────────────

function MediaPreview({
  content,
  actions,
  getPreviewUrl,
  onDownload,
}: {
  content: FileContent;
  actions: FileActions;
  getPreviewUrl: (path: string) => Promise<string>;
  onDownload: () => void;
}) {
  const kind = classifyMedia(content.path, content.contentType);
  const name = content.path.split("/").pop() ?? content.path;

  const downloadCard = (reason: string) => (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <FileIcon className="h-8 w-8 text-[var(--color-fg-subtle)]" />
      <div className="text-sm text-[var(--color-fg-muted)]">{reason}</div>
      <div className="font-mono text-xs text-[var(--color-fg-subtle)]">
        {name} · {formatSize(content.size)} · {content.contentType}
      </div>
      <Button variant="outline" size="sm" onClick={onDownload}>
        <Download className="h-3.5 w-3.5" /> Download
      </Button>
    </div>
  );

  // Non-media binary, or a domain with no signed-URL preview (mediaMode==="download").
  if (kind === "binary" || actions.mediaMode !== "preview") {
    return downloadCard(
      kind === "binary"
        ? "Not a previewable media type."
        : "Preview not available here — download to view.",
    );
  }

  if (kind === "image") {
    return (
      <ImagePreview content={content} getPreviewUrl={getPreviewUrl} onDownload={onDownload} />
    );
  }
  // video
  return <VideoPreview content={content} getPreviewUrl={getPreviewUrl} onDownload={onDownload} />;
}

/**
 * Image preview. Images have NO Range — a large one downloads fully before it
 * paints — so per the #93 verdict there is no hard byte cap: a large-image
 * warning with an opt-in "Load anyway" (plus a Download escape) IS the boundary.
 * "Large" is a soft advisory heuristic on the reported size, not a gate.
 */
const LARGE_IMAGE_ADVISORY = 8 * 1024 * 1024; // 8 MiB — advisory only, not a cap.

function ImagePreview({
  content,
  getPreviewUrl,
  onDownload,
}: {
  content: FileContent;
  getPreviewUrl: (path: string) => Promise<string>;
  onDownload: () => void;
}) {
  const isLarge = content.size >= LARGE_IMAGE_ADVISORY;
  const [forceLoad, setForceLoad] = useState(!isLarge);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setForceLoad(!isLarge);
    setUrl(null);
    setError(false);
  }, [content.path, isLarge]);

  useEffect(() => {
    if (!forceLoad) return;
    let alive = true;
    void getPreviewUrl(content.path)
      .then((u) => alive && setUrl(u))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [forceLoad, content.path, getPreviewUrl]);

  if (isLarge && !forceLoad) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <AlertTriangle className="h-8 w-8 text-[var(--color-warning)]" />
        <div className="text-sm text-[var(--color-fg-muted)]">
          Large image ({formatSize(content.size)}). Images can't stream — loading pulls the
          whole file and may hang the pane.
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setForceLoad(true)}>
            Load anyway
          </Button>
          <Button variant="ghost" size="sm" onClick={onDownload}>
            <Download className="h-3.5 w-3.5" /> Download instead
          </Button>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm text-[var(--color-danger)]">
        <FileWarning className="h-5 w-5" />
        Failed to load image.
        <Button variant="outline" size="sm" onClick={onDownload}>
          <Download className="h-3.5 w-3.5" /> Download instead
        </Button>
      </div>
    );
  }

  if (!url) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-fg-subtle)]">
        Loading…
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-[var(--color-bg)] p-4">
      <img
        src={url}
        alt={content.path}
        onError={() => setError(true)}
        className="max-h-full max-w-full rounded-md border border-[var(--color-border)] object-contain"
      />
    </div>
  );
}

/**
 * Video preview. Range → 206 streaming (proven in #88) means size is not the
 * gate; the signed-URL lifetime is. On an `onError` (403 / expiry) we silently
 * re-sign — fetch a fresh previewUrl and retry — per the "Re-sign & resume"
 * verdict. A second failure surfaces a download fallback.
 */
function VideoPreview({
  content,
  getPreviewUrl,
  onDownload,
}: {
  content: FileContent;
  getPreviewUrl: (path: string) => Promise<string>;
  onDownload: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  // Guard against an infinite re-sign loop when the URL is genuinely broken.
  const resignedRef = useRef(false);

  const load = useCallback(() => {
    let alive = true;
    void getPreviewUrl(content.path)
      .then((u) => alive && setUrl(u))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [content.path, getPreviewUrl]);

  useEffect(() => {
    resignedRef.current = false;
    setUrl(null);
    setError(false);
    return load();
  }, [content.path, load]);

  const handleError = useCallback(() => {
    // First error → assume an expired signature and silently re-sign once.
    if (!resignedRef.current) {
      resignedRef.current = true;
      setUrl(null);
      load();
    } else {
      setError(true);
    }
  }, [load]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm text-[var(--color-danger)]">
        <FileWarning className="h-5 w-5" />
        Failed to load video.
        <Button variant="outline" size="sm" onClick={onDownload}>
          <Download className="h-3.5 w-3.5" /> Download instead
        </Button>
      </div>
    );
  }
  if (!url) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-fg-subtle)]">
        Loading…
      </div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center bg-black p-4">
      <video src={url} controls onError={handleError} className="max-h-full max-w-full rounded-md" />
    </div>
  );
}

// ─── Selected-file pane: dispatch text → editor, media → preview ───────────────

function FilePane({
  content,
  loading,
  error,
  actions,
  writeError,
  saving,
  saved,
  onSave,
  getPreviewUrl,
  onDownload,
}: {
  content: FileContent | null;
  loading: boolean;
  error: string | null;
  actions: FileActions;
  writeError: string | undefined;
  saving: boolean;
  saved: boolean;
  onSave: (text: string, onSuccess: () => void) => void;
  getPreviewUrl: (path: string) => Promise<string>;
  onDownload: () => void;
}) {
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-fg-subtle)]">
        Loading…
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-[var(--color-danger)]">
        <FileWarning className="h-5 w-5" />
        {error}
      </div>
    );
  }
  if (!content) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-fg-subtle)]">
        Select a file
      </div>
    );
  }

  const kind = classifyMedia(content.path, content.contentType);

  // Text → shared editor (writable) or read-only viewer.
  if (kind === "text" && !content.isBinary && content.text !== null) {
    if (actions.canSave) {
      return (
        <div className="h-full overflow-auto p-4">
          {actions.writeDisabledReason && (
            <div className="mb-3 rounded-md bg-[var(--color-bg-muted)] px-3 py-2 text-xs text-[var(--color-fg-muted)]">
              {actions.writeDisabledReason}
            </div>
          )}
          {/* When idle-gated mid-turn, keep the surface but block Save via a
              disabled editor (writeDisabledReason shown above); 423 is the
              server-side TOCTOU backstop. */}
          <TextFileEditor
            resetKey={content.path}
            initialContent={content.text}
            loading={!!actions.writeDisabledReason}
            saving={saving}
            error={writeError}
            saved={saved}
            heading={content.path}
            onSave={onSave}
          />
        </div>
      );
    }
    // Read-only text (no write capability).
    return (
      <pre className="h-full overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs text-[var(--color-fg)]">
        {content.text}
      </pre>
    );
  }

  return (
    <MediaPreview
      content={content}
      actions={actions}
      getPreviewUrl={getPreviewUrl}
      onDownload={onDownload}
    />
  );
}

// ─── Upload dropzone (inline, Split layout — #93 verdict) ──────────────────────

function Dropzone({
  onFiles,
  uploading,
  disabled,
  disabledReason,
}: {
  onFiles: (files: File[]) => void;
  uploading: boolean;
  disabled: boolean;
  disabledReason: string | null;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      onDragOver={(e) => {
        if (disabled) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (disabled) return;
        if (e.dataTransfer.files.length) onFiles(Array.from(e.dataTransfer.files));
      }}
      className={cn(
        "flex flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed p-3 text-center transition-colors",
        dragging
          ? "border-[var(--color-primary)] bg-[var(--color-accent-muted)]"
          : "border-[var(--color-border)]",
        disabled && "opacity-50",
      )}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) onFiles(Array.from(e.target.files));
          e.target.value = "";
        }}
      />
      <UploadCloud className="h-5 w-5 text-[var(--color-fg-subtle)]" />
      <button
        type="button"
        disabled={disabled}
        className="text-xs text-[var(--color-fg-muted)] underline disabled:no-underline"
        onClick={() => inputRef.current?.click()}
      >
        {uploading ? "Uploading…" : "Drag files here or click to select"}
      </button>
      {disabled && disabledReason && (
        <span className="text-[10px] text-[var(--color-fg-subtle)]">{disabledReason}</span>
      )}
    </div>
  );
}

// ─── The component ─────────────────────────────────────────────────────────────

/** Best-effort detection of the server-side idle-gate 423 (TOCTOU backstop). */
function isLockedError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? "";
  return /\b423\b|locked/i.test(msg);
}

/** Shown when a write fails the server-side idle gate (423) after the client
 *  optimistically allowed it — the TOCTOU backstop. Distinct from the
 *  pre-emptive {@link WRITE_LOCKED_REASON} ("稍后可编辑") the button gate uses. */
const WRITE_LOCKED_RETRY = "Agent 运行中，稍后重试";

/** Message for a failed write: the retry hint if it was the idle gate, else the raw error. */
function writeErrorMessage(err: unknown): string {
  return isLockedError(err) ? WRITE_LOCKED_RETRY : (err as Error).message;
}

export function FileManager({ source, turnStatus, refreshKey = 0, emptyHint }: FileManagerProps) {
  const methods = useMemo(() => methodsOf(source), [source]);
  const actions = useMemo(
    () => resolveFileActions(source.capabilities, methods, turnStatus),
    [source.capabilities, methods, turnStatus],
  );

  const [nodes, setNodes] = useState<FileNode[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState<FileContent | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [writeError, setWriteError] = useState<string | undefined>();
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false); // rename/delete in flight

  const nested = source.capabilities.hierarchy === "nested" && actions.showDirs;

  const refresh = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      setNodes(await source.list());
    } catch (err) {
      setListError((err as Error).message);
    } finally {
      setListLoading(false);
    }
  }, [source]);

  const openFile = useCallback(
    async (path: string) => {
      setSelectedPath(path);
      setContentLoading(true);
      setContentError(null);
      setWriteError(undefined);
      setSaved(false);
      try {
        setContent(await source.read(path));
      } catch (err) {
        setContent(null);
        setContentError((err as Error).message);
      } finally {
        setContentLoading(false);
      }
    },
    [source],
  );

  // Load / reload the tree when the source or host refreshKey changes.
  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  // Reselect / drop the open file after a refresh (agent may have rewritten it).
  useEffect(() => {
    if (!selectedPath) return;
    if (nodes.some((n) => n.path === selectedPath && !n.isDir)) {
      void openFile(selectedPath);
    } else {
      setSelectedPath(null);
      setContent(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleSave = useCallback(
    (text: string, onSuccess: () => void) => {
      if (!source.write || !selectedPath) return;
      setSaving(true);
      setWriteError(undefined);
      setSaved(false);
      void source
        .write(selectedPath, text)
        .then(() => {
          setContent((current) =>
            current && current.path === selectedPath
              ? { ...current, text, size: new Blob([text]).size }
              : current,
          );
          setSaved(true);
          onSuccess();
        })
        .catch((err) => {
          setWriteError(writeErrorMessage(err));
        })
        .finally(() => setSaving(false));
    },
    [source, selectedPath],
  );

  const getPreviewUrl = useCallback(
    (path: string) => {
      if (!source.previewUrl) return Promise.reject(new Error("No preview URL"));
      return source.previewUrl(path);
    },
    [source],
  );

  const handleDownload = useCallback(async () => {
    if (!selectedPath) return;
    try {
      const url = source.previewUrl
        ? await source.previewUrl(selectedPath)
        : null;
      if (url) {
        const a = document.createElement("a");
        a.href = url;
        a.download = selectedPath.split("/").pop() ?? selectedPath;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    } catch {
      // best-effort; the preview pane already surfaces load errors.
    }
  }, [source, selectedPath]);

  const handleUpload = useCallback(
    async (files: File[], explicitDestDir?: string) => {
      if (!source.upload || files.length === 0) return;
      setUploading(true);
      setListError(null);
      try {
        const destDir = actions.allowSubdirs
          ? explicitDestDir ?? currentDir(selectedPath)
          : undefined;
        await source.upload(files, destDir);
        await refresh();
      } catch (err) {
        setListError(writeErrorMessage(err));
      } finally {
        setUploading(false);
      }
    },
    [source, actions.allowSubdirs, selectedPath, refresh],
  );

  const handleNewFile = useCallback(async () => {
    if (!source.write) return;
    const name = window.prompt(
      actions.allowSubdirs ? "New file path (e.g. notes/todo.md)" : "New file name",
    );
    if (!name) return;
    setBusy(true);
    setWriteError(undefined);
    try {
      await source.write(name, "");
      await refresh();
      await openFile(name);
    } catch (err) {
      setWriteError(writeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [source, actions.allowSubdirs, refresh, openFile]);

  const handleRename = useCallback(async () => {
    if (!source.rename || !selectedPath) return;
    const to = window.prompt("Rename to", selectedPath);
    if (!to || to === selectedPath) return;
    setBusy(true);
    try {
      await source.rename(selectedPath, to);
      setSelectedPath(null);
      setContent(null);
      await refresh();
      await openFile(to);
    } catch (err) {
      setContentError(writeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [source, selectedPath, refresh, openFile]);

  const handleDelete = useCallback(async () => {
    if (!source.delete || !selectedPath) return;
    if (!window.confirm(`Delete ${selectedPath}?`)) return;
    setBusy(true);
    try {
      await source.delete(selectedPath);
      setSelectedPath(null);
      setContent(null);
      await refresh();
    } catch (err) {
      setContentError(writeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [source, selectedPath, refresh]);

  const tree = useMemo(
    () => (nested ? buildTree(nodes.map((n) => ({ path: n.path, size: n.size ?? 0, updated_at: n.updatedAt ?? null }))) : null),
    [nested, nodes],
  );

  // Write actions are disabled up front while idle-gated mid-turn.
  const writeGated = actions.writeDisabledReason !== null;

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2">
        <span className="min-w-0 truncate text-xs font-medium text-[var(--color-fg-muted)]">
          {nodes.filter((n) => !n.isDir).length} file
          {nodes.filter((n) => !n.isDir).length === 1 ? "" : "s"}
          {selectedPath && (
            <>
              <span className="mx-2 text-[var(--color-border)]">|</span>
              <span className="font-mono text-[var(--color-fg)]">{selectedPath}</span>
            </>
          )}
        </span>
        <div className="flex flex-shrink-0 items-center gap-1">
          {actions.canSave && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleNewFile}
              disabled={writeGated || busy}
              title={writeGated ? actions.writeDisabledReason! : "New file"}
            >
              <FilePlus className="h-3.5 w-3.5" />
            </Button>
          )}
          {actions.canRename && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRename}
              disabled={!selectedPath || writeGated || busy}
              title={writeGated ? actions.writeDisabledReason! : "Rename"}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          )}
          {actions.canDelete && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDelete}
              disabled={!selectedPath || writeGated || busy}
              title={writeGated ? actions.writeDisabledReason! : "Delete"}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void refresh()}
            disabled={listLoading}
            title="Refresh"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", listLoading && "animate-spin")} />
          </Button>
        </div>
      </div>

      {/* Body: tree + selected-file pane */}
      <div className="flex min-h-0 flex-1">
        <div className="flex w-64 flex-shrink-0 flex-col border-r border-[var(--color-border)]">
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {listError ? (
              <div className="px-2 py-4 text-xs text-[var(--color-danger)]">{listError}</div>
            ) : listLoading && nodes.length === 0 ? (
              <div className="px-2 py-4 text-xs text-[var(--color-fg-subtle)]">Loading…</div>
            ) : nodes.length === 0 ? (
              <div className="px-2 py-4 text-xs text-[var(--color-fg-subtle)]">
                {emptyHint ?? "No files yet."}
              </div>
            ) : nested && tree ? (
              tree.children.map((node) => (
                <TreeRow
                  key={node.path}
                  node={node}
                  depth={0}
                  selectedPath={selectedPath}
                  expanded={expanded}
                  onToggle={toggle}
                  onSelect={openFile}
                  onDropFiles={actions.canUpload && !writeGated ? handleUpload : undefined}
                />
              ))
            ) : (
              // Flat source: list files directly, no folder hierarchy.
              nodes
                .filter((n) => !n.isDir)
                .map((n) => (
                  <TreeRow
                    key={n.path}
                    node={{ name: n.path, path: n.path, isDir: false, size: n.size, children: [] }}
                    depth={0}
                    selectedPath={selectedPath}
                    expanded={expanded}
                    onToggle={toggle}
                    onSelect={openFile}
                  />
                ))
            )}
          </div>

          {actions.canUpload && (
            <div className="border-t border-[var(--color-border)] p-2">
              <Dropzone
                onFiles={handleUpload}
                uploading={uploading}
                disabled={writeGated}
                disabledReason={actions.writeDisabledReason}
              />
            </div>
          )}
        </div>

        {/* Selected-file pane */}
        <div className="min-w-0 flex-1 overflow-hidden bg-[var(--color-bg-surface)]">
          <FilePane
            content={content}
            loading={contentLoading}
            error={contentError}
            actions={actions}
            writeError={writeError}
            saving={saving}
            saved={saved}
            onSave={handleSave}
            getPreviewUrl={getPreviewUrl}
            onDownload={() => void handleDownload()}
          />
        </div>
      </div>
    </div>
  );
}

/** Directory of a selected path (upload destination on nested sources). */
function currentDir(path: string | null): string | undefined {
  if (!path) return undefined;
  const idx = path.lastIndexOf("/");
  return idx > 0 ? path.slice(0, idx) : undefined;
}
