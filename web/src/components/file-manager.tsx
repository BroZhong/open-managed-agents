import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
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
  Music,
  Pencil,
  Trash2,
  FilePlus,
  FolderPlus,
  ListCollapse,
  Search,
  PanelLeft,
  ArrowLeft,
} from "lucide-react";
import { useCompactPanel } from "@/lib/hooks/use-compact-panel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TextFileEditor } from "@/components/text-file-editor";
import { AudioPreview } from "@/components/audio-preview";
import { useMediaPreviewUrl, usePlayableMediaPreview, type PreviewUrlLoader } from "@/lib/hooks/use-media-preview-url";
import { buildTree, formatSize, isDirectoryPath, type TreeNode } from "@/lib/workspace-tree";
import { collectUploadFiles, type UploadInput } from "@/lib/upload-files";
import {
  classifyMedia,
  methodsOf,
  resolveFileActions,
  resolveFilePresentation,
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
 *  - selection ← `source.read(path)` → `classifyMedia` → text / image / video / audio / binary
 *  - buttons   ← `resolveFileActions(capabilities, methodsOf(source), turnStatus)`
 *  - writes    ← `source.write / rename / delete / upload`
 *  - media     ← `source.previewUrl` (image: large-image opt-in; video: silent re-sign)
 */
export interface FileManagerProps {
  source: FileSource;
  fileSelection?: { path: string; nonce: number };
  /** Injected by the host page (from its existing SSE). Not subscribed here. */
  turnStatus: TurnStatus;
  /** Bumped by the host on a file-change SSE event / turn end to force a refetch. */
  refreshKey?: number;
  /** Copy shown above the tree when it is empty. */
  emptyHint?: string;
  presentation?: "default" | "workbench";
  rootLabel?: string;
  selectionHint?: string;
}

// ─── Tree rendering (mirrors workspace-panel's TreeRow visual language) ────────

/** File drags stay inside the manager, including while writes are disabled. */
function useFileDrop(onFiles?: (input: UploadInput) => void) {
  const [dragging, setDragging] = useState(false);
  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = onFiles ? "copy" : "none";
    setDragging(!!onFiles);
  };

  return {
    dragging: dragging && !!onFiles,
    handlers: {
      onDragEnter: onDragOver,
      onDragOver,
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setDragging(false);
      },
      onDragEnd: () => setDragging(false),
      onDrop: (event: DragEvent<HTMLElement>) => {
        event.preventDefault();
        event.stopPropagation();
        setDragging(false);
        // Directory drags expose a placeholder File, not the files inside it.
        // Pass the transfer synchronously so its entries can be captured while
        // the drop event still permits access to the drag data store.
        if (Array.from(event.dataTransfer.types).includes("Files")) onFiles?.(event.dataTransfer);
      },
    },
  };
}

function TreeRow({
  node,
  depth,
  selectedPath,
  uploadDir,
  expanded,
  onToggle,
  onSelect,
  onDropFiles,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  uploadDir: string;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onDropFiles?: (input: UploadInput, destDir: string) => void;
}) {
  const isOpen = expanded.has(node.path);
  const isSelected = node.isDir ? node.path === uploadDir : node.path === selectedPath;
  const kind: MediaKind | null = node.isDir ? null : classifyMedia(node.path, "");
  const destDir = node.isDir ? node.path : currentDir(node.path) ?? "";
  const drop = useFileDrop(onDropFiles ? (files) => onDropFiles(files, destDir) : undefined);

  return (
    <>
      <button
        type="button"
        onClick={() => (node.isDir ? onToggle(node.path) : onSelect(node.path))}
        {...drop.handlers}
        aria-expanded={node.isDir ? isOpen : undefined}
        aria-current={isSelected ? "true" : undefined}
        data-file-path={node.path}
        title={onDropFiles ? `Drop files into /${destDir}` : undefined}
        className={cn(
          "file-tree-row flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm transition-colors",
          isSelected
            ? "bg-[var(--color-bg-muted)] text-[var(--color-fg)]"
            : "text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)]",
          drop.dragging && "bg-[var(--color-accent-muted)] ring-2 ring-inset ring-[var(--color-primary)]",
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
        <span className="file-tree-name flex-1 truncate font-mono text-xs">{node.name}</span>
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
            uploadDir={uploadDir}
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
  if (kind === "audio") return <Music className={c} />;
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
  getPreviewUrl: PreviewUrlLoader;
  onDownload: () => void;
}) {
  const kind = classifyMedia(content.path, content.contentType);
  const presentation = resolveFilePresentation(content, actions.mediaMode);
  const name = content.path.split("/").pop() ?? content.path;

  const downloadCard = (reason: string) => (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <FileIcon className="h-8 w-8 text-[var(--color-fg-subtle)]" />
      <div className="text-sm text-[var(--color-fg-muted)]">{reason}</div>
      <div className="font-mono text-xs text-[var(--color-fg-subtle)]">
        {name} · {formatSize(content.size)} · {content.contentType}
      </div>
      <Button variant="outline" size="sm" onClick={() => onDownload()}>
        <Download className="h-3.5 w-3.5" /> Download
      </Button>
    </div>
  );

  // Anything without a concrete renderable body/media type falls back safely.
  if (presentation === "download") {
    return downloadCard(
      kind === "binary"
        ? "Not a previewable media type."
        : "Preview not available here — download to view.",
    );
  }

  if (presentation === "image") {
    return (
      <ImagePreview
        key={content.path}
        content={content}
        getPreviewUrl={getPreviewUrl}
        onDownload={onDownload}
      />
    );
  }
  if (presentation === "audio") {
    return (
      <AudioPreview
        key={content.path}
        content={content}
        getPreviewUrl={getPreviewUrl}
        onDownload={onDownload}
      />
    );
  }
  // The only remaining presentation is video.
  return (
    <VideoPreview
      key={content.path}
      content={content}
      getPreviewUrl={getPreviewUrl}
      onDownload={onDownload}
    />
  );
}

function ImagePreview({
  content,
  getPreviewUrl,
  onDownload,
}: {
  content: FileContent;
  getPreviewUrl: PreviewUrlLoader;
  onDownload: () => void;
}) {
  const { url, error, handleError, markLoaded, markRecovered } = useMediaPreviewUrl(content.path, getPreviewUrl);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm text-[var(--color-danger)]">
        <FileWarning className="h-5 w-5" />
        Failed to load image.
        <Button
          variant="outline"
          size="sm"
          onClick={() => onDownload()}
        >
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
    <div className="relative flex h-full items-center justify-center overflow-auto bg-[var(--color-bg)] p-4">
      <Button
        variant="outline"
        size="sm"
        className="absolute right-3 top-3 z-10"
        onClick={() => onDownload()}
      >
        <Download className="h-3.5 w-3.5" /> Download
      </Button>
      <img
        crossOrigin="anonymous"
        src={url}
        alt={content.path}
        onError={handleError}
        onLoad={() => { markLoaded(); markRecovered(); }}
        className="max-h-full max-w-full rounded-md border border-[var(--color-border)] object-contain"
      />
    </div>
  );
}

/** Native Range playback with signed-URL recovery and bounded consecutive failures. */
function VideoPreview({
  content,
  getPreviewUrl,
  onDownload,
}: {
  content: FileContent;
  getPreviewUrl: PreviewUrlLoader;
  onDownload: () => void;
}) {
  const { url, error, mediaEvents, mediaRef } = usePlayableMediaPreview(content.path, getPreviewUrl);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm text-[var(--color-danger)]">
        <FileWarning className="h-5 w-5" />
        Failed to load video.
        <Button
          variant="outline"
          size="sm"
          onClick={() => onDownload()}
        >
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
    <div className="relative flex h-full items-center justify-center bg-black p-4">
      <Button
        variant="outline"
        size="sm"
        className="absolute right-3 top-3 z-10"
        onClick={() => onDownload()}
      >
        <Download className="h-3.5 w-3.5" /> Download
      </Button>
      <video
        ref={mediaRef}
        crossOrigin="anonymous"
        src={url}
        controls
        preload="metadata"
        {...mediaEvents}
        className="max-h-full max-w-full rounded-md"
      />
    </div>
  );
}

// ─── Selected-file pane: dispatch text → editor, media → preview ───────────────

function FilePane({
  workbench = false,
  selectionHint,
  content,
  contentRevision,
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
  workbench?: boolean;
  selectionHint: string;
  content: FileContent | null;
  contentRevision: number;
  loading: boolean;
  error: string | null;
  actions: FileActions;
  writeError: string | undefined;
  saving: boolean;
  saved: boolean;
  onSave: (text: string, onSuccess: () => void) => void;
  getPreviewUrl: PreviewUrlLoader;
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
      <div className={workbench ? "workspace-preview-empty" : "flex h-full items-center justify-center text-sm text-[var(--color-fg-subtle)]"}>
        {workbench && <FileIcon />}
        <span>Select a file</span>
        {workbench && <p>{selectionHint}</p>}
      </div>
    );
  }

  const presentation = resolveFilePresentation(content, actions.mediaMode);

  // Text → shared editor (writable) or read-only viewer.
  if (presentation === "text" && content.text !== null) {
    if (actions.canSave) {
      return (
        <div className="file-text-surface h-full overflow-auto p-4">
          {actions.writeDisabledReason && (
            <div className="mb-3 rounded-md bg-[var(--color-bg-muted)] px-3 py-2 text-xs text-[var(--color-fg-muted)]">
              {actions.writeDisabledReason}
            </div>
          )}
          {/* When idle-gated mid-turn, keep the surface but block Save via a
              disabled editor (writeDisabledReason shown above); 423 is the
              server-side TOCTOU backstop. */}
          <TextFileEditor
            resetKey={`${content.path}:${contentRevision}`}
            initialContent={content.text}
            loading={!!actions.writeDisabledReason}
            saving={saving}
            error={writeError}
            saved={saved}
            heading={workbench ? undefined : content.path}
            previewMarkdown={workbench && /\.md(?:own)?$/i.test(content.path)}
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
      key={`${content.path}:${contentRevision}`}
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
  destDir,
  allowDirectories,
}: {
  onFiles: (input: UploadInput) => void;
  uploading: boolean;
  disabled: boolean;
  disabledReason: string | null;
  destDir: string;
  allowDirectories: boolean;
}) {
  const drop = useFileDrop(disabled ? undefined : onFiles);
  const inputRef = useRef<HTMLInputElement>(null);
  const directoryInputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      {...drop.handlers}
      className={cn(
        "flex flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed p-3 text-center transition-colors",
        drop.dragging
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
        disabled={disabled}
        onChange={(e) => {
          if (!disabled && e.target.files?.length) onFiles(Array.from(e.target.files));
          e.target.value = "";
        }}
      />
      {allowDirectories && (
        <input
          ref={directoryInputRef}
          type="file"
          // @ts-expect-error non-standard directory-picker attribute
          webkitdirectory=""
          multiple
          hidden
          disabled={disabled}
          onChange={(event) => {
            if (!disabled && event.target.files?.length) onFiles(Array.from(event.target.files));
            event.target.value = "";
          }}
        />
      )}
      <UploadCloud className="h-5 w-5 text-[var(--color-fg-subtle)]" />
      <button
        type="button"
        disabled={disabled}
        className="text-xs text-[var(--color-fg-muted)] underline disabled:no-underline"
        onClick={() => inputRef.current?.click()}
      >
        {uploading ? "Uploading…" : "Drag files here or click to select"}
      </button>
      {allowDirectories && (
        <button
          type="button"
          disabled={disabled}
          className="text-xs text-[var(--color-fg-muted)] underline disabled:no-underline"
          onClick={() => directoryInputRef.current?.click()}
        >
          Choose folder
        </button>
      )}
      <span className="max-w-full truncate font-mono text-[10px] text-[var(--color-fg-subtle)]" title={`Upload to /${destDir}`}>
        Upload to /{destDir}
      </span>
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

export function FileManager({ source, fileSelection, turnStatus, refreshKey = 0, emptyHint, presentation = "default", rootLabel = "Workspace", selectionHint = "Browse your Workspace to preview or edit a file alongside the Session." }: FileManagerProps) {
  const workbench = presentation === "workbench";
  const managerRef = useRef<HTMLDivElement>(null);
  const compact = useCompactPanel(managerRef, 520);
  const [search, setSearch] = useState("");
  const [newItem, setNewItem] = useState<"file" | "folder" | null>(null);
  const [newItemName, setNewItemName] = useState("");
  const [newItemError, setNewItemError] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const importFolderRef = useRef<HTMLInputElement>(null);
  const [directoryOpen, setDirectoryOpen] = useState(true);
  const [detailOpen, setDetailOpen] = useState(false);
  const methods = useMemo(() => methodsOf(source), [source]);
  const actions = useMemo(
    () => resolveFileActions(source.capabilities, methods, turnStatus),
    [source.capabilities, methods, turnStatus],
  );

  const nodesRef = useRef<FileNode[]>([]);
  const readVersion = useRef(0);
  const readAbortRef = useRef<AbortController | null>(null);
  const invalidateRead = useCallback(() => {
    ++readVersion.current;
    readAbortRef.current?.abort();
  }, []);
  useEffect(() => () => invalidateRead(), [source, invalidateRead]);
  const scrolledRequest = useRef<number | undefined>(undefined);
  const [nodes, setNodes] = useState<FileNode[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [uploadDir, setUploadDir] = useState("");
  const [content, setContent] = useState<FileContent | null>(null);
  const [contentRevision, setContentRevision] = useState(0);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [writeError, setWriteError] = useState<string | undefined>();
  const [uploading, setUploading] = useState(false);
  const uploadInFlight = useRef(false);
  const uploadContext = useRef<{ source: FileSource; locked: boolean } | null>(null);
  useEffect(() => {
    uploadContext.current = { source, locked: actions.writeDisabledReason !== null };
    return () => { uploadContext.current = null; };
  }, [source, actions.writeDisabledReason]);
  const [busy, setBusy] = useState(false); // rename/delete in flight

  const nested = source.capabilities.hierarchy === "nested" && actions.showDirs;

  const refresh = useCallback(async (): Promise<FileNode[] | null> => {
    setListLoading(true);
    setListError(null);
    setSaved(false);
    try {
      const nextNodes = await source.list();
      nodesRef.current = nextNodes;
      setNodes(nextNodes);
      return nextNodes;
    } catch (err) {
      setListError((err as Error).message);
      return null;
    } finally {
      setListLoading(false);
    }
  }, [source]);

  const revealPath = useCallback((path: string, directory: boolean) => {
    setSearch("");
    setDirectoryOpen(true);
    const parts = path.split("/").filter(Boolean);
    if (!directory) parts.pop();
    setExpanded((current) => {
      const next = new Set(current);
      for (let i = 1; i <= parts.length; i++) next.add(parts.slice(0, i).join("/"));
      return next;
    });
  }, []);

  const openFile = useCallback(
    async (requestedPath: string, selectUploadDir = true) => {
      invalidateRead();
      const version = readVersion.current;
      const controller = new AbortController();
      readAbortRef.current = controller;
      const directory = nested && isDirectoryPath(requestedPath, nodesRef.current);
      const path = requestedPath.replace(/\/+$/, "");
      setContentError(null);
      setDownloadError(null);
      setWriteError(undefined);
      setSaved(false);
      if (directory) {
        revealPath(path, true);
        setUploadDir(path);
        setSelectedPath(null);
        setContent(null);
        setContentLoading(false);
        setDetailOpen(false);
        return;
      }
      setSelectedPath(path);
      setDetailOpen(true);
      if (selectUploadDir) setUploadDir(currentDir(path) ?? "");
      setContentLoading(true);
      try {
        const nextContent = await source.read(path, { signal: controller.signal });
        if (version !== readVersion.current) return;
        setContent(nextContent);
        setContentRevision((revision) => revision + 1);
      } catch (err) {
        if (version !== readVersion.current) return;
        setContent(null);
        setContentError((err as Error).message);
      } finally {
        if (version === readVersion.current) setContentLoading(false);
      }
    },
    [source, nested, revealPath, invalidateRead],
  );

  useEffect(() => {
    if (!fileSelection) return;
    let cancelled = false;
    invalidateRead();
    // Refresh first so a directory created by the latest Turn is classified
    // from the current listing before attempting any file read.
    void source.list().then(async (nextNodes) => {
      if (cancelled) return;
      nodesRef.current = nextNodes;
      setNodes(nextNodes);
      setListError(null);
      revealPath(fileSelection.path, isDirectoryPath(fileSelection.path, nextNodes));
      await openFile(fileSelection.path);
    }).catch((err: unknown) => {
      if (!cancelled) setListError(err instanceof Error ? err.message : "Failed to load files");
    });
    return () => { cancelled = true; invalidateRead(); };
  }, [fileSelection, source, openFile, revealPath, invalidateRead]);

  useEffect(() => {
    if (!fileSelection || scrolledRequest.current === fileSelection.nonce) return;
    const path = fileSelection.path.replace(/\/+$/, "");
    const row = Array.from(managerRef.current?.querySelectorAll<HTMLElement>("[data-file-path]") ?? [])
      .find((element) => element.dataset.filePath === path);
    if (row) {
      row.scrollIntoView?.({ block: "nearest" });
      scrolledRequest.current = fileSelection.nonce;
    }
  }, [fileSelection, nodes, expanded]);

  /** Refresh the tree and reload/drop the selected file from the same snapshot. */
  const refreshSelected = useCallback(
    async (path: string | null = selectedPath) => {
      const version = readVersion.current;
      const nextNodes = await refresh();
      if (!nextNodes || !path || version !== readVersion.current) return;
      if (nextNodes.some((node) => node.path === path && !node.isDir)) {
        await openFile(path, false);
      } else {
        setSelectedPath(null);
        setContent(null);
      }
    },
    [openFile, refresh, selectedPath],
  );

  // A new source or Host refresh pulse is one atomic tree + selected-content
  // refresh. `refreshSelected` is deliberately omitted: selecting a file changes
  // that callback, but must not itself trigger a second network reload.
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (active) return refreshSelected();
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, refreshKey]);

  const toggle = useCallback((path: string) => {
    setUploadDir(path);
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
    (...args: Parameters<PreviewUrlLoader>) => {
      if (!source.previewUrl) return Promise.reject(new Error("No preview URL"));
      return source.previewUrl(...args);
    },
    [source],
  );

  const handleDownload = useCallback(async () => {
    if (!selectedPath) return;
    setDownloadError(null);
    try {
      if (!source.downloadUrl) throw new Error("Download is unavailable for this file.");
      const url = await source.downloadUrl(selectedPath);
      triggerDownload(url, selectedPath);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : "Failed to download file.");
    }
  }, [source, selectedPath]);

  const handleUpload = useCallback(
    async (input: UploadInput, explicitDestDir?: string) => {
      if (!source.upload || actions.writeDisabledReason || uploadInFlight.current) return;
      uploadInFlight.current = true;
      setUploading(true);
      setListError(null);
      try {
        const destDir = actions.allowSubdirs
          ? (explicitDestDir ?? uploadDir) || undefined
          : undefined;
        setUploadDir(destDir ?? "");
        const files = await collectUploadFiles(input);
        // A directory scan can outlive a source change or the start of a Turn.
        if (uploadContext.current?.source !== source) return;
        if (uploadContext.current.locked) throw new Error(WRITE_LOCKED_RETRY);
        if (!files.length) throw new Error("The folder contains no files. Empty folders cannot be uploaded.");
        await source.upload(files, destDir);
        await refreshSelected();
        if (destDir) {
          setExpanded((previous) => {
            const next = new Set(previous);
            const segments = destDir.split("/");
            segments.forEach((_, index) => next.add(segments.slice(0, index + 1).join("/")));
            return next;
          });
        }
      } catch (err) {
        setListError(writeErrorMessage(err));
      } finally {
        uploadInFlight.current = false;
        setUploading(false);
      }
    },
    [source, actions.allowSubdirs, actions.writeDisabledReason, uploadDir, refreshSelected],
  );

  const handleNewFile = useCallback(async () => {
    if (!source.write) return;
    if (workbench) {
      setNewItem("file");
      setNewItemName(`${uploadDir ? uploadDir + "/" : ""}untitled.md`);
      setNewItemError(null);
      return;
    }
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
  }, [source, actions.allowSubdirs, refresh, openFile, workbench, uploadDir]);

  async function createItem() {
    const path = newItemName.trim();
    if (!path || busy || writeGated) return;
    if (path.split("/").some((part) => !part || part === "." || part === "..")) {
      setNewItemError("Enter a valid relative path.");
      return;
    }
    setBusy(true);
    setNewItemError(null);
    try {
      const current = await source.list();
      if (current.some((node) => node.path === path || node.path.startsWith(path + "/"))) {
        throw new Error("This name already exists. Choose another name.");
      }
      if (newItem === "folder") await source.createDirectory!(path);
      else await source.write!(path, /\.md$/i.test(path) ? `# ${path.split("/").pop()!.replace(/\.md$/i, "")}\n` : "");
      await refresh();
      const directory = newItem === "folder" ? path : currentDir(path);
      if (directory) {
        setUploadDir(directory);
        setExpanded((previous) => {
          const next = new Set(previous);
          directory.split("/").forEach((_, index, parts) => next.add(parts.slice(0, index + 1).join("/")));
          return next;
        });
      }
      if (newItem === "file") await openFile(path);
      setNewItem(null);
    } catch (error) {
      setNewItemError(writeErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

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

  const visibleNodes = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query ? nodes.filter((node) => node.path.toLowerCase().includes(query)) : nodes;
  }, [nodes, search]);
  const tree = useMemo(
    () => (nested ? buildTree(visibleNodes.map((n) => ({ path: n.path, isDir: n.isDir, size: n.size, updated_at: n.updatedAt ?? null }))) : null),
    [nested, visibleNodes],
  );
  const visibleExpanded = useMemo(() => {
    if (!search.trim()) return expanded;
    const paths = new Set(expanded);
    for (const node of visibleNodes) {
      const parts = node.path.split("/");
      for (let i = 1; i < parts.length; i++) paths.add(parts.slice(0, i).join("/"));
    }
    return paths;
  }, [expanded, search, visibleNodes]);

  // Write actions are disabled up front while idle-gated mid-turn.
  const writeGated = actions.writeDisabledReason !== null;
  const uploadDisabled = writeGated || uploading;
  const rootDrop = useFileDrop(
    actions.canUpload && !uploadDisabled ? (files) => void handleUpload(files, "") : undefined,
  );

  return (
    <div
      ref={managerRef}
      className={cn("file-manager flex h-full flex-col", workbench && "file-manager-workbench")}
      data-compact={workbench && compact}
      data-directory-open={directoryOpen}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "none";
      }}
      onDrop={(event) => {
        if (event.dataTransfer.files.length) event.preventDefault();
      }}
    >
      {/* Toolbar for embedded Skill and Agent file editors. */}
      {!workbench && <div className="file-manager-toolbar flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2">
        {workbench && <span className="workspace-heading" title={rootLabel}><FolderOpen /><span className="truncate">{rootLabel}</span></span>}
        <span className="min-w-0 truncate text-xs font-medium text-[var(--color-fg-muted)]">
          {nodes.filter((n) => !n.isDir).length} file
          {nodes.filter((n) => !n.isDir).length === 1 ? "" : "s"}
          {!workbench && selectedPath && (
            <>
              <span className="mx-2 text-[var(--color-border)]">|</span>
              <span className="font-mono text-[var(--color-fg)]">{selectedPath}</span>
            </>
          )}
        </span>
        <div className="flex flex-shrink-0 items-center gap-1">
          {actions.canCreate && (
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
            onClick={() => void refreshSelected()}
            disabled={listLoading}
            title="Refresh"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", listLoading && "animate-spin")} />
          </Button>
        </div>
      </div>}

      {workbench && actions.canUpload && <>
        <input ref={importRef} type="file" multiple hidden disabled={uploadDisabled} onChange={(event) => { if (event.target.files?.length) void handleUpload(Array.from(event.target.files)); event.target.value = ""; }} />
        <input ref={importFolderRef} type="file" multiple hidden disabled={uploadDisabled}
          // @ts-expect-error non-standard directory-picker attribute
          webkitdirectory=""
          onChange={(event) => { if (event.target.files?.length) void handleUpload(Array.from(event.target.files)); event.target.value = ""; }} />
      </>}
      {/* Body: tree + selected-file pane */}
      <div className="file-manager-body flex min-h-0 flex-1">
        <div
          className={cn("file-directory flex w-64 flex-shrink-0 flex-col border-r border-[var(--color-border)]", workbench && rootDrop.dragging && "file-directory-dragging")}
          {...(workbench ? rootDrop.handlers : {})}
          hidden={workbench && (compact ? detailOpen : !directoryOpen)}
          inert={workbench && (compact ? detailOpen : !directoryOpen)}
        >
          {workbench && (
            <div className="file-directory-heading">
              <button type="button" className="file-directory-collapse" aria-label="Hide file directory" title="Hide file directory" onClick={() => setDirectoryOpen(false)}><PanelLeft /></button>
              <button type="button" className="workspace-heading" title={rootLabel} onClick={() => setUploadDir("")}><span className="truncate">{rootLabel}</span></button>
              <div className="workspace-tools">
                {actions.canUpload && <details className="workspace-import-menu">
                  <summary className="workspace-tool" aria-label="Import files" title="Import files"><UploadCloud /></summary>
                  <div className="workspace-import-options">
                    <button type="button" disabled={uploadDisabled} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); importRef.current?.click(); }}>Upload files</button>
                    {actions.allowSubdirs && <button type="button" disabled={uploadDisabled} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); importFolderRef.current?.click(); }}>Upload folder</button>}
                  </div>
                </details>}
                {actions.canCreate && <button type="button" className="workspace-tool" title="New file" aria-label="New file" disabled={writeGated || busy} onClick={handleNewFile}><FilePlus /></button>}
                {source.createDirectory && <button type="button" className="workspace-tool" title="New folder" aria-label="New folder" disabled={writeGated || busy} onClick={() => { setNewItem("folder"); setNewItemName(`${uploadDir ? uploadDir + "/" : ""}New folder`); setNewItemError(null); }}><FolderPlus /></button>}
                <button type="button" className="workspace-tool" title="Collapse folders" aria-label="Collapse folders" onClick={() => setExpanded(new Set())}><ListCollapse /></button>
              </div>
            </div>
          )}
          {workbench && (
            <label className="file-search">
              <Search />
              <input aria-label="Search files" placeholder="Search files…" value={search} onChange={(event) => setSearch(event.target.value)} />
            </label>
          )}
          {!workbench && nested && actions.canUpload && (
            <button
              type="button"
              onClick={() => setUploadDir("")}
              {...rootDrop.handlers}
              title="Drop files into /"
              className={cn(
                "mx-2 mt-2 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-[var(--color-fg-muted)]",
                uploadDir === "" && "bg-[var(--color-bg-muted)] text-[var(--color-fg)]",
                rootDrop.dragging && "bg-[var(--color-accent-muted)] ring-2 ring-inset ring-[var(--color-primary)]",
              )}
            >
              <FolderOpen className="h-3.5 w-3.5 flex-shrink-0" />
              Root directory /
            </button>
          )}
          {workbench && newItem && <form className="workspace-new-item" onSubmit={(event) => { event.preventDefault(); void createItem(); }}>
            <label>{newItem === "folder" ? "Folder name" : "File name"}
              <input autoFocus aria-label={newItem === "folder" ? "Folder name" : "File name"} value={newItemName} disabled={busy} onChange={(event) => setNewItemName(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && !busy) setNewItem(null); }} />
            </label>
            {newItemError && <p role="alert">{newItemError}</p>}
            <div><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setNewItem(null)}>Cancel</Button><Button type="submit" size="sm" disabled={busy || !newItemName.trim()}>{busy ? "Creating…" : "Create"}</Button></div>
          </form>}
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {listError && (
              <div role="alert" className="px-2 py-4 text-xs text-[var(--color-danger)]">
                Could not refresh files. {nodes.length > 0 && "The last loaded list is shown below. "}
                File status is unconfirmed; use Refresh to retry. <span>{listError}</span>
              </div>
            )}
            {listLoading && nodes.length === 0 ? (
              <div className="px-2 py-4 text-xs text-[var(--color-fg-subtle)]">Loading…</div>
            ) : nodes.length === 0 ? (
              !listError && <div className="px-2 py-4 text-xs text-[var(--color-fg-subtle)]">
                {emptyHint ?? "No files yet."}
              </div>
            ) : visibleNodes.length === 0 ? (
              <p className="px-2 py-4 text-xs text-[var(--color-fg-muted)]">No matching files.</p>
            ) : nested && tree ? (
              tree.children.map((node) => (
                <TreeRow
                  key={node.path}
                  node={node}
                  depth={0}
                  selectedPath={selectedPath}
                  uploadDir={uploadDir}
                  expanded={visibleExpanded}
                  onToggle={toggle}
                  onSelect={openFile}
                  onDropFiles={actions.canUpload && !uploadDisabled ? handleUpload : undefined}
                />
              ))
            ) : (
              // Flat source: list files directly, no folder hierarchy.
              visibleNodes
                .filter((n) => !n.isDir)
                .map((n) => (
                  <TreeRow
                    key={n.path}
                    node={{ name: n.path, path: n.path, isDir: false, size: n.size, children: [] }}
                    depth={0}
                    selectedPath={selectedPath}
                    uploadDir={uploadDir}
                    expanded={visibleExpanded}
                    onToggle={toggle}
                    onSelect={openFile}
                  />
                ))
            )}
          </div>

          {!workbench && actions.canUpload && (
            <div className="border-t border-[var(--color-border)] p-2">
              <Dropzone
                onFiles={handleUpload}
                uploading={uploading}
                disabled={uploadDisabled}
                disabledReason={actions.writeDisabledReason}
                destDir={actions.allowSubdirs ? uploadDir : ""}
                allowDirectories={actions.allowSubdirs}
              />
            </div>
          )}
          {workbench && <div className="workspace-directory-footer">
            <span role={uploading ? "status" : undefined}>{uploading ? "Uploading…" : `${nodes.filter((node) => !node.isDir).length} files`}</span>
            <button type="button" className="workspace-tool" aria-label="Refresh" title="Refresh" disabled={listLoading} onClick={() => void refreshSelected()}><RefreshCw className={listLoading ? "animate-spin" : ""} /></button>
          </div>}
        </div>

        {/* Selected-file pane */}
        <div
          className="file-preview min-w-0 flex-1 overflow-hidden bg-[var(--color-bg-surface)]"
          hidden={workbench && compact && !detailOpen}
          inert={workbench && compact && !detailOpen}
        >
          {workbench && (
            <div className="file-preview-bar">
              {(compact || !directoryOpen) && <button type="button" className="file-directory-reopen" onClick={() => { setDetailOpen(false); setDirectoryOpen(true); }}><ArrowLeft />Files</button>}
              <span className="file-preview-name" title={selectedPath ?? undefined}>{selectedPath ?? ""}</span>
              <div className="workspace-tools">
                <button type="button" className="workspace-tool" title="Show file in directory" aria-label="Show file in directory" disabled={!selectedPath} onClick={() => {
                  setDirectoryOpen(true); setDetailOpen(false); setSearch("");
                  const parts = (selectedPath ?? "").split("/");
                  setExpanded((previous) => new Set([...previous, ...parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"))]));
                }}><FolderOpen /></button>
                {actions.canRename && <button type="button" className="workspace-tool" title="Rename" aria-label="Rename file" disabled={!selectedPath || writeGated || busy} onClick={handleRename}><Pencil /></button>}
                {actions.canDelete && <button type="button" className="workspace-tool" title="Delete" aria-label="Delete file" disabled={!selectedPath || writeGated || busy} onClick={handleDelete}><Trash2 /></button>}
                {source.downloadUrl && <button type="button" className="workspace-tool" title="Download" aria-label="Download file" disabled={!selectedPath || contentLoading} onClick={() => void handleDownload()}><Download /></button>}
              </div>
            </div>
          )}
          {downloadError && <p role="alert" className="p-3 text-sm text-[var(--color-danger)]">Download failed: {downloadError}</p>}
          <div className="file-preview-content">
          <FilePane
            workbench={workbench}
            selectionHint={selectionHint}
            content={content}
            contentRevision={contentRevision}
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
    </div>
  );
}

/** Directory of a selected path (upload destination on nested sources). */
function currentDir(path: string | null): string | undefined {
  if (!path) return undefined;
  const idx = path.lastIndexOf("/");
  return idx > 0 ? path.slice(0, idx) : undefined;
}

function triggerDownload(url: string, path: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = path.split("/").pop() ?? path;
  // Attachment response headers drive storage downloads. A separate target
  // also keeps errors or an unexpected inline response out of the application.
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
