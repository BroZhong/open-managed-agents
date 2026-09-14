import { extname } from "node:path";

const contentTypes: Record<string, string> = {
  ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".ts": "text/plain; charset=utf-8", ".tsx": "text/plain; charset=utf-8",
  ".py": "text/plain; charset=utf-8", ".sh": "text/plain; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8", ".yml": "text/yaml; charset=utf-8",
  ".toml": "text/plain; charset=utf-8", ".json": "application/json",
  ".csv": "text/csv; charset=utf-8", ".xml": "application/xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
  ".svg": "image/svg+xml", ".bmp": "image/bmp", ".ico": "image/x-icon",
  ".tif": "image/tiff", ".tiff": "image/tiff",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
  ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".m4a": "audio/mp4", ".flac": "audio/flac", ".aac": "audio/aac",
  ".pdf": "application/pdf", ".zip": "application/zip", ".gz": "application/gzip",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** ossfs does not always set useful object MIME metadata. Keep meaningful
 * metadata, otherwise infer common preview/download formats from the filename. */
export function resolveArtifactContentType(path: string, stored?: string): string {
  const mime = stored?.split(";")[0].trim().toLowerCase();
  if (mime && !["application/octet-stream", "binary/octet-stream", "application/x-empty", "text/plain"].includes(mime)) return stored!;
  return contentTypes[extname(path).toLowerCase()] ?? stored ?? "application/octet-stream";
}
