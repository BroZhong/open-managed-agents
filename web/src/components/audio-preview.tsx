import { Download, FileWarning, Music } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { FileContent } from "@/lib/file-source";
import { usePlayableMediaPreview, type PreviewUrlLoader } from "@/lib/hooks/use-media-preview-url";
import { formatSize } from "@/lib/workspace-tree";

/** Audio uses the same signed storage URL flow as images and video. */
export function AudioPreview({
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
        Failed to load audio. The file may be unavailable or its format unsupported.
        <Button variant="outline" size="sm" onClick={() => onDownload()}>
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
        ref={mediaRef}
        crossOrigin="anonymous"
        aria-label={content.path}
        src={url}
        controls
        preload="metadata"
        {...mediaEvents}
        className="w-full max-w-md"
      />
      <Button variant="outline" size="sm" onClick={() => onDownload()}>
        <Download className="h-3.5 w-3.5" /> Download
      </Button>
    </div>
  );
}
