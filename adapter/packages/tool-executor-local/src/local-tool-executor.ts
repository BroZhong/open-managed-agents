import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { access, appendFile, lstat, mkdtemp, mkdir, open, readFile, realpath, writeFile, rm, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ExecAbortedBeforeStartError } from "@open-managed-agents/adapter-core";
import type {
  ExecOptions,
  ExecExitResult,
  ExecOutputChunk,
  FileListEntry,
  ToolExecutor,
  ToolFileSystem,
  ToolFileSystemOptions,
  ToolFileStat,
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
  readonly fileSystem: ToolFileSystem;

  constructor(options: LocalToolExecutorOptions) {
    this.root = resolve(options.root);
    const target = (path: string) => this.resolveInside(path, "path");
    // Check cancellation around metadata calls too. Never race a mutation:
    // callers can release their mutation lock only after the I/O has settled.
    const run = async <T>(options: ToolFileSystemOptions | undefined, operation: () => Promise<T>): Promise<T> => {
      options?.signal?.throwIfAborted();
      const result = await operation();
      options?.signal?.throwIfAborted();
      return result;
    };
    const describe = (value: Stats): ToolFileStat => ({
      isFile: value.isFile(),
      isDirectory: value.isDirectory(),
      isSymbolicLink: value.isSymbolicLink(),
      size: value.size,
      mtimeMs: value.mtimeMs,
    });
    this.fileSystem = {
      readFile: (path, options) => run(options, () => readFile(target(path), options)),
      writeFile: (path, content, options) => run(options, () => writeFile(target(path), content, options)),
      access: (path, mode, options) => run(options, () => access(target(path), mode)),
      stat: (path, options) => run(options, async () => describe(await stat(target(path)))),
      lstat: (path, options) => run(options, async () => describe(await lstat(target(path)))),
      realpath: (path, options) => run(options, () => realpath(target(path))),
      readdir: (path, options) => run(options, () => readdir(target(path))),
      mkdir: (path, options) => run(options, async () => { await mkdir(target(path), { recursive: true }); }),
      createTempFile: (options) => run(options, async () => {
        const path = join(this.root, `.oma-tmp-${randomUUID()}.log`);
        const file = await open(path, "wx", 0o600);
        await file.close();
        return path;
      }),
      appendFile: (path, content, options) => run(options, () => appendFile(target(path), content)),
    };
  }

  private resolveInside(p: string | undefined, label: string): string {
    const target = resolve(this.root, p ?? ".");
    const rel = relative(this.root, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw Object.assign(new Error(`${label} escapes executor root: ${p}`), { code: "EACCES", path: p });
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

    // Retain exact bytes as well as independently decoded text. ignoreBOM
    // matches Buffer.toString("utf8"): a leading BOM is content, not metadata.
    for (const [stream, pipe] of [["stdout", child.stdout], ["stderr", child.stderr]] as const) {
      const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
      pipe.on("data", (data: Buffer) => {
        const bytes = new Uint8Array(data);
        queue.push({ stream, text: decoder.decode(bytes, { stream: true }), bytes });
        wake();
      });
      pipe.on("end", () => {
        const text = decoder.decode();
        if (text) queue.push({ stream, text, bytes: new Uint8Array() });
        wake();
      });
    }
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
