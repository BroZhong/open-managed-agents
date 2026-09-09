import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ExecAbortedBeforeStartError } from "@open-managed-agents/adapter-core";
import type {
  ExecOptions,
  ExecExitResult,
  ExecOutputChunk,
  FileListEntry,
  ToolExecutor,
} from "@open-managed-agents/adapter-core";

export interface LocalToolExecutorOptions {
  /**
   * Root directory the executor is confined to. All paths are resolved
   * relative to it and may not escape it. If omitted, use {@link createLocal}
   * to allocate a fresh per-call temp dir instead.
   */
  root: string;
}

/**
 * In-process {@link ToolExecutor} backed by a real directory on the local
 * filesystem. It is deliberately dumb: no sandbox, no S3, no network. Its only
 * job is to prove the seam works — every `run()` call gets its own instance
 * over its own root, so two concurrent runs share nothing.
 *
 * Path safety: every `path`/`cwd` is resolved against `root` and rejected if
 * it escapes. `exec` runs `command` as argv (no shell) with `cwd` inside root.
 */
export class LocalToolExecutor implements ToolExecutor {
  readonly root: string;

  constructor(options: LocalToolExecutorOptions) {
    this.root = resolve(options.root);
  }

  private resolveInside(p: string | undefined, label: string): string {
    const target = resolve(this.root, p ?? ".");
    const rel = relative(this.root, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`${label} escapes executor root: ${p}`);
    }
    return target;
  }

  async *exec(
    command: string[],
    opts?: ExecOptions,
  ): AsyncIterable<ExecOutputChunk> {
    if (command.length === 0) {
      throw new Error("exec requires a non-empty command");
    }
    const cwd = this.resolveInside(opts?.cwd, "cwd");
    await mkdir(cwd, { recursive: true });
    if (opts?.signal?.aborted) {
      throw new ExecAbortedBeforeStartError();
    }

    const [cmd, ...args] = command;
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...(opts?.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      // A separate process group lets cancellation stop shell descendants too.
      detached: process.platform !== "win32",
    });

    const kill = () => {
      try {
        if (process.platform !== "win32" && child.pid) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
        // Some host sandboxes permit terminating a child but reject process
        // group signals. The direct child still needs to be reaped normally.
        try {
          if (child.kill("SIGKILL")) return;
        } catch {
          // Preserve the original failure through the iterator, never throw
          // from an AbortSignal listener or timer callback.
        }
        killError = error instanceof Error ? error : new Error(String(error));
      }
    };
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (opts?.timeoutSeconds) {
      timeoutId = setTimeout(kill, opts.timeoutSeconds * 1000);
    }

    // Bridge the two byte streams into a single ordered async queue.
    const queue: ExecOutputChunk[] = [];
    let resolveNext: (() => void) | undefined;
    let done = false;
    let error: Error | undefined;
    let killError: Error | undefined;
    let exitResult: ExecExitResult | undefined;
    let exitReported = false;
    const reportExit = () => {
      if (!exitReported && exitResult) {
        exitReported = true;
        opts?.onExit?.(exitResult);
      }
    };

    const wake = () => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = undefined;
        r();
      }
    };

    const push = (stream: "stdout" | "stderr") => (text: string) => {
      queue.push({ stream, text });
      wake();
    };
    // Each pipe retains its own decoder state across byte chunks and flushes
    // at EOF. A chunk boundary can split a Chinese character or an emoji.
    child.stdout.setEncoding("utf8").on("data", push("stdout"));
    child.stderr.setEncoding("utf8").on("data", push("stderr"));
    child.on("error", (e) => {
      error = e instanceof Error ? e : new Error(String(e));
    });
    const closed = new Promise<void>((resolveClosed) => child.on("close", (exitCode, signal) => {
      if (!error) exitResult = { exitCode, ...(signal ? { signal } : {}) };
      done = true;
      wake();
      resolveClosed();
    }));
    const onAbort = () => {
      if (!done) kill();
    };
    opts?.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts?.signal?.aborted) onAbort();

    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (done) {
          reportExit();
          if (killError) throw killError;
          if (error) throw error;
          if (opts?.signal?.aborted && exitResult?.signal) {
            throw new DOMException("Command aborted", "AbortError");
          }
          return;
        }
        await new Promise<void>((r) => {
          resolveNext = r;
        });
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      opts?.signal?.removeEventListener("abort", onAbort);
      if (!done) {
        kill();
        await closed;
      }
      reportExit();
    }
  }

  async readFile(path: string): Promise<string> {
    const target = this.resolveInside(path, "path");
    return readFile(target, "utf8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    const target = this.resolveInside(path, "path");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }

  async list(globOrDir?: string): Promise<FileListEntry[]> {
    const base = this.resolveInside(
      globOrDir && !globOrDir.includes("*") ? globOrDir : ".",
      "path",
    );
    const pattern = globOrDir && globOrDir.includes("*") ? globOrDir : undefined;

    let baseIsDir = false;
    try {
      baseIsDir = (await stat(base)).isDirectory();
    } catch {
      return [];
    }
    if (!baseIsDir) {
      const s = await stat(base);
      return [
        {
          path: this.toRelPosix(base),
          size: s.size,
          mtimeMs: s.mtimeMs,
        },
      ];
    }

    const entries: FileListEntry[] = [];
    const walk = async (dir: string): Promise<void> => {
      const dirents = await readdir(dir, { withFileTypes: true });
      for (const dirent of dirents) {
        const full = join(dir, dirent.name);
        if (dirent.isDirectory()) {
          await walk(full);
        } else if (dirent.isFile()) {
          const relPosix = this.toRelPosix(full);
          if (pattern && !matchGlob(pattern, relPosix)) continue;
          const s = await stat(full);
          entries.push({ path: relPosix, size: s.size, mtimeMs: s.mtimeMs });
        }
      }
    };
    await walk(base);
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return entries;
  }

  private toRelPosix(absPath: string): string {
    return relative(this.root, absPath).split(sep).join("/");
  }
}

/**
 * Allocate a fresh per-call {@link LocalToolExecutor} over a brand-new temp
 * directory, plus a `dispose()` to remove it. This is the shape a Host uses to
 * inject a distinct executor into every `run()` call.
 */
export async function createLocalToolExecutor(
  prefix = "oma-tool-exec-",
): Promise<{ executor: LocalToolExecutor; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const executor = new LocalToolExecutor({ root });
  return {
    executor,
    dispose: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Minimal glob matcher supporting `*` (any run of non-`/` chars) and `**`
 * (any run including `/`). Anchored to the whole relative path.
 */
function matchGlob(pattern: string, path: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
  }
  return new RegExp("^" + re + "$").test(path);
}
