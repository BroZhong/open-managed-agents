import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FileWarning, Music } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { FileContent } from "@/lib/file-source";
import { formatSize } from "@/lib/workspace-tree";

/** Audio uses the same authenticated preview URL path as images and video. */
export function AudioPreview({
  content,
  getPreviewUrl,
  onDownload,
}: {
  content: FileContent;
  getPreviewUrl: (path: string) => Promise<string>;
  onDownload: (readyUrl?: string) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const retriedRef = useRef(false);

  useEffect(() => {
    let alive = true;
    let acquiredUrl: string | null = null;
    const release = (value: string | null) => {
      if (value?.startsWith("blob:")) URL.revokeObjectURL(value);
    };

    void getPreviewUrl(content.path)
      .then((value) => {
        acquiredUrl = value;
        if (alive) setUrl(value);
        else release(value);
      })
      .catch(() => {
        if (alive) setError(true);
      });

    return () => {
      alive = false;
      release(acquiredUrl);
    };
  }, [content.path, getPreviewUrl, retry]);

  const handleError = useCallback(() => {
    // Refresh a potentially expired URL once; unsupported codecs then fall
    // back to download instead of repeatedly trying the same file.
    if (!retriedRef.current) {
      retriedRef.current = true;
      setUrl(null);
      setRetry((value) => value + 1);
    } else {
      setError(true);
    }
  }, []);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm text-[var(--color-danger)]">
        <FileWarning className="h-5 w-5" />
        Failed to load audio. The file may be unavailable or its format unsupported.
        <Button variant="outline" size="sm" onClick={() => onDownload(url ?? undefined)}>
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

  const name = content.path.split("/").pop() ?? content.path;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-[var(--color-bg)] p-6 text-center">
      <Music className="h-10 w-10 text-[var(--color-fg-subtle)]" />
      <div className="min-w-0 max-w-full">
        <div className="break-all text-sm text-[var(--color-fg)]">{name}</div>
        <div className="mt-1 text-xs text-[var(--color-fg-subtle)]">{formatSize(content.size)}</div>
      </div>
      <audio
        aria-label={content.path}
        src={url}
        controls
        preload="metadata"
        onError={handleError}
        className="w-full max-w-md"
      />
      <Button variant="outline" size="sm" onClick={() => onDownload(url)}>
        <Download className="h-3.5 w-3.5" /> Download
      </Button>
    </div>
  );
}
