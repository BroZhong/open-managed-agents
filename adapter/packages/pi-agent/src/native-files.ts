import { SANDBOX_WORKSPACE_ROOT, type ToolExecutor, type ToolFileSystem } from "@open-managed-agents/adapter-core";

/** Absolute projections and temporary files remain inside the executor's boundary. */
export function toExecutorPath(path: string): string {
  if (path === SANDBOX_WORKSPACE_ROOT) return ".";
  const prefix = `${SANDBOX_WORKSPACE_ROOT}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

export function executorFileSystem(executor: ToolExecutor): ToolFileSystem {
  if (!executor.fileSystem) throw new Error("Pi tools require the executor's native fileSystem operations");
  return executor.fileSystem;
}

/** Match native fs.access(F_OK), while keeping cancellation observable. */
export async function fileExists(fs: ToolFileSystem, path: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) throw new Error("Operation aborted");
  try {
    await fs.access(toExecutorPath(path), 0, { signal });
    return true;
  } catch (error) {
    if (signal?.aborted) throw new Error("Operation aborted");
    // Native filesystem access failures mean false. A failed RPC or malformed
    // helper response is not evidence that the file is absent.
    if (typeof error === "object" && error !== null && "code" in error
      && ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP", "ENAMETOOLONG"].includes(String(error.code))) {
      return false;
    }
    if (typeof error === "object" && error !== null && "syscall" in error && error.syscall === "access") return false;
    throw error;
  }
}
