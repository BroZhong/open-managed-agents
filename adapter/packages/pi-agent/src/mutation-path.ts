import { posix } from "node:path";
import type { ToolFileSystem } from "@open-managed-agents/adapter-core";
import { toExecutorPath } from "./native-files.js";

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

/**
 * Keep mutation lock keys stable while a new file becomes visible. The model's
 * /home/user prefix can project to a different executor root, so Pi's unresolved
 * input path is not necessarily the canonical path returned after creation.
 * Resolve the nearest existing ancestor (including symlink parents) and append
 * missing segments. Actual filesystem operations still use their original paths.
 */
export async function canonicalMutationPath(
  fs: ToolFileSystem,
  modelAbsolutePath: string,
  signal?: AbortSignal,
): Promise<string> {
  let current = modelAbsolutePath;
  const missing: string[] = [];
  for (;;) {
    try {
      const canonical = await fs.realpath(toExecutorPath(current), { signal });
      return posix.join(canonical, ...missing);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      const parent = posix.dirname(current);
      if (parent === current) throw error;
      missing.unshift(posix.basename(current));
      current = parent;
    }
  }
}
