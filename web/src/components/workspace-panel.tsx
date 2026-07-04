import { useMemo, useState, useCallback, useEffect } from "react";
import {
  RefreshCw,
  Download,
  File as FileIcon,
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  FileWarning,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useWorkspaceFiles, type FilePreview } from "@/lib/hooks/use-workspace-files";
import { buildTree, formatSize, type TreeNode } from "@/lib/workspace-tree";

interface WorkspacePanelProps {
  sessionId: string;
  /** Bumped by the file-change SSE event and turn end to trigger a refetch. */
  refreshKey: number;
}

// ─── Tree rendering ──────────────────────────────────────────────────────────

function TreeRow({
  node,
  depth,
  selectedPath,
  expanded,
  onToggle,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  const isOpen = expanded.has(node.path);
  const isSelected = !node.isDir && node.path === selectedPath;

  return (
    <>
      <button
        type="button"
        onClick={() => (node.isDir ? onToggle(node.path) : onSelect(node.path))}
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
            <FileIcon className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-fg-subtle)]" />
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
          />
        ))}
    </>
  );
}

// ─── Preview pane ────────────────────────────────────────────────────────────

function PreviewPane({
  preview,
  loading,
  error,
}: {
  preview: FilePreview | null;
  loading: boolean;
  error: string | null;
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
  if (!preview) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-fg-subtle)]">
        Select a file to preview
      </div>
    );
  }
  if (preview.isBinary || preview.text === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-[var(--color-fg-subtle)]">
        <FileWarning className="h-5 w-5" />
        <span>Preview not available for this file type.</span>
        <span className="text-xs">
          {preview.contentType} · {formatSize(preview.size)}
        </span>
      </div>
    );
  }
  return (
    <pre className="h-full overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs text-[var(--color-fg)]">
      {preview.text}
    </pre>
  );
}

// ─── Panel ───────────────────────────────────────────────────────────────────

export function WorkspacePanel({ sessionId, refreshKey }: WorkspacePanelProps) {
  const { files, isLoading, error, refresh, preview, download } = useWorkspaceFiles(
    sessionId,
    refreshKey,
  );
  const tree = useMemo(() => buildTree(files), [files]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<FilePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const loadPreview = useCallback(
    async (path: string) => {
      setSelectedPath(path);
      setPreviewLoading(true);
      setPreviewError(null);
      try {
        setPreviewData(await preview(path));
      } catch (err) {
        setPreviewData(null);
        setPreviewError((err as Error).message);
      } finally {
        setPreviewLoading(false);
      }
    },
    [preview],
  );

  // Re-fetch the open file when the workspace changes (agent may have rewritten it).
  useEffect(() => {
    if (!selectedPath) return;
    // Only refresh if the selected file still exists in the tree.
    if (files.some((f) => f.path === selectedPath)) {
      void loadPreview(selectedPath);
    } else {
      setSelectedPath(null);
      setPreviewData(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const handleDownload = useCallback(async () => {
    if (!selectedPath) return;
    setDownloading(true);
    try {
      await download(selectedPath);
    } catch {
      // surfaced via preview error area is overkill; swallow — download is best-effort
    } finally {
      setDownloading(false);
    }
  }, [download, selectedPath]);

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2">
        <span className="text-xs font-medium text-[var(--color-fg-muted)]">
          {files.length} file{files.length === 1 ? "" : "s"}
          {selectedPath && (
            <>
              <span className="mx-2 text-[var(--color-border)]">|</span>
              <span className="font-mono text-[var(--color-fg)]">{selectedPath}</span>
            </>
          )}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDownload}
            disabled={!selectedPath || downloading}
            title="Download selected file"
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void refresh()}
            disabled={isLoading}
            title="Refresh file tree"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isLoading && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Body: tree + preview */}
      <div className="flex min-h-0 flex-1">
        {/* File tree */}
        <div className="w-64 flex-shrink-0 overflow-auto border-r border-[var(--color-border)] p-2">
          {error ? (
            <div className="px-2 py-4 text-xs text-[var(--color-danger)]">{error}</div>
          ) : isLoading && files.length === 0 ? (
            <div className="px-2 py-4 text-xs text-[var(--color-fg-subtle)]">Loading…</div>
          ) : files.length === 0 ? (
            <div className="px-2 py-4 text-xs text-[var(--color-fg-subtle)]">
              No files yet. Files created by the agent appear here.
            </div>
          ) : (
            tree.children.map((node) => (
              <TreeRow
                key={node.path}
                node={node}
                depth={0}
                selectedPath={selectedPath}
                expanded={expanded}
                onToggle={toggle}
                onSelect={loadPreview}
              />
            ))
          )}
        </div>

        {/* Preview */}
        <div className="min-w-0 flex-1 overflow-hidden bg-[var(--color-bg-surface)]">
          <PreviewPane preview={previewData} loading={previewLoading} error={previewError} />
        </div>
      </div>
    </div>
  );
}
