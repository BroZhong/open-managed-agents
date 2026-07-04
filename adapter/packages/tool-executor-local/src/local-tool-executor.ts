import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  ExecOptions,
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

    const [cmd, ...args] = command;
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...(opts?.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (opts?.timeoutSeconds) {
      timeoutId = setTimeout(() => {
        child.kill("SIGTERM");
      }, opts.timeoutSeconds * 1000);
    }

    // Bridge the two byte streams into a single ordered async queue.
    const queue: ExecOutputChunk[] = [];
    let resolveNext: (() => void) | undefined;
    let done = false;
    let error: Error | undefined;

    const wake = () => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = undefined;
        r();
      }
    };

    const push = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      queue.push({ stream, text: chunk.toString("utf8") });
      wake();
    };
    child.stdout.on("data", push("stdout"));
    child.stderr.on("data", push("stderr"));
    child.on("error", (e) => {
      error = e instanceof Error ? e : new Error(String(e));
      done = true;
      wake();
    });
    child.on("close", () => {
      done = true;
      wake();
    });

    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (done) {
          if (error) throw error;
          return;
        }
        await new Promise<void>((r) => {
          resolveNext = r;
        });
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (!done) child.kill("SIGTERM");
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
