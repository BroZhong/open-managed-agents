import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceFile } from "@/lib/types";
import { encodePath } from "@/lib/workspace-tree";

const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const STORAGE_KEY = "oma_api_key";

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem(STORAGE_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function filesBase(sessionId: string): string {
  return `${BASE_URL}/v1/sessions/${sessionId}/workspace/files`;
}

export interface FilePreview {
  path: string;
  /** Text body when the file is previewable as text, else null. */
  text: string | null;
  contentType: string;
  size: number;
  /** True when the content is binary / not rendered as text. */
  isBinary: boolean;
}

const TEXT_LIKE = /^(text\/|application\/(json|javascript|xml|x-yaml|yaml)|image\/svg)/;
const MAX_TEXT_PREVIEW = 512 * 1024; // 512 KiB

// S3 stores whatever MIME was set at write time, which is unreliable for
// shell-created files (a `.md` written via curl can end up as
// application/x-www-form-urlencoded). Fall back to the file extension so
// well-known text files still preview inline.
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "json", "yaml", "yml", "xml", "csv", "tsv", "log",
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt",
  "c", "h", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "sql", "toml", "ini",
  "cfg", "conf", "env", "html", "css", "scss", "svg", "gitignore", "dockerfile",
]);

function isTextByExtension(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : name.toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

/**
 * Lists a session's Workspace files through the Host proxy and previews a
 * selected file. The tree refetches whenever `refreshKey` changes (driven by
 * the file-change SSE event and turn end). S3 is the source of truth, so
 * shell-created files appear too.
 */
export function useWorkspaceFiles(sessionId: string, refreshKey: number) {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(filesBase(sessionId), {
        headers: { ...authHeaders(), Accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Failed to list files: ${res.status}`);
      const body = await res.json();
      const data: WorkspaceFile[] = body.data ?? [];
      data.sort((a, b) => a.path.localeCompare(b.path));
      setFiles(data);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
    return () => abortRef.current?.abort();
    // refreshKey drives incremental/turn-end refetches.
  }, [refresh, refreshKey]);

  const preview = useCallback(
    async (path: string): Promise<FilePreview> => {
      const res = await fetch(`${filesBase(sessionId)}/${encodePath(path)}`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`Failed to load file: ${res.status}`);
      const contentType = res.headers.get("content-type") ?? "application/octet-stream";
      const size = Number(res.headers.get("content-length") ?? "0");
      const isText = TEXT_LIKE.test(contentType) || isTextByExtension(path);
      if (isText && size <= MAX_TEXT_PREVIEW) {
        return { path, text: await res.text(), contentType, size, isBinary: false };
      }
      // Drain the body to release the connection; we don't render binary inline.
      await res.arrayBuffer().catch(() => undefined);
      return { path, text: null, contentType, size, isBinary: true };
    },
    [sessionId],
  );

  const download = useCallback(
    async (path: string) => {
      const res = await fetch(
        `${filesBase(sessionId)}/${encodePath(path)}?download=1`,
        { headers: authHeaders() },
      );
      if (!res.ok) throw new Error(`Failed to download file: ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = path.split("/").pop() ?? "download";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    [sessionId],
  );

  return { files, isLoading, error, refresh, preview, download };
}
