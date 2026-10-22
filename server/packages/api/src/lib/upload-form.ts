import type { HonoRequest } from "hono";

/** One uploaded file and the container-relative path the form asks for. */
export interface UploadedFile {
  path: string;
  file: File;
}

export type UploadForm =
  | { ok: true; files: UploadedFile[] }
  | { ok: false; error: string };

/**
 * The multipart upload form of the Workspace and Skill file uploads: one or
 * more File fields. A single file may name its exact target with `path`;
 * otherwise each file goes under `destDir` by its own filename, which carries
 * the folder path of a dropped directory. The caller validates the paths.
 */
export async function readUploadForm(req: HonoRequest): Promise<UploadForm> {
  const form = await req.parseBody({ all: true }).catch(() => null);
  if (!form) return { ok: false, error: "Invalid multipart body" };

  const destDir = typeof form.destDir === "string" ? form.destDir : "";
  const explicitPath = typeof form.path === "string" ? form.path : undefined;

  // Collect all File-valued form entries (a field may hold one or many).
  const files: File[] = [];
  for (const value of Object.values(form)) {
    for (const v of Array.isArray(value) ? value : [value]) {
      if (v instanceof File) files.push(v);
    }
  }
  if (files.length === 0) return { ok: false, error: "No files in upload" };

  return {
    ok: true,
    files: files.map((file) => ({
      path: files.length === 1 && explicitPath ? explicitPath : joinPath(destDir, file.name),
      file,
    })),
  };
}

/**
 * Join a directory and a filename into a relative path, tolerating a missing
 * or slash-suffixed directory. An empty dir yields the bare name.
 */
function joinPath(dir: string, name: string): string {
  const d = dir.replace(/\/+$/, "");
  return d ? `${d}/${name}` : name;
}
