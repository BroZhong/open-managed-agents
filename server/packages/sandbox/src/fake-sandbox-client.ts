import type {
  SandboxClient,
  SandboxCreateOptions,
  SandboxExecChunk,
  SandboxExecOptions,
  SandboxFileEntry,
  SandboxHandle,
} from "./sandbox-client.js";

interface FakeFile {
  content: string | Uint8Array;
  mtimeMs: number;
}

interface FakeSandbox {
  id: string;
  files: Map<string, FakeFile>;
  destroyed: boolean;
  /**
   * Simulates the gateway reclaiming a sandbox after its lifetime: the handle
   * is still known here but no longer live. Ops against it fail as they would
   * against a real reclaimed sandbox, and {@link isAlive} reports false — this
   * is the seam tests use to exercise the executor's liveness-rebuild path.
   */
  reclaimed: boolean;
  createOpts: SandboxCreateOptions;
}

/**
 * A custom command handler for the fake, keyed by the first argv element.
 * Receives the argv and the sandbox's in-memory file map and returns the
 * chunks to stream back. Lets tests simulate a tool reading a hydrated file
 * (e.g. `cat /workspace/foo.txt`) without any real process.
 */
export type FakeExecHandler = (
  command: string[],
  files: Map<string, FakeFile>,
  opts?: SandboxExecOptions,
) => SandboxExecChunk[];

export interface FakeSandboxClientOptions {
  /** Deterministic id generator; defaults to `sbx-fake-<n>`. */
  generateId?: () => string;
  /**
   * Optional handler for `exec` calls. If it returns `undefined` the default
   * built-in handling (cat/ls/echo) applies.
   */
  execHandler?: (
    command: string[],
    files: Map<string, FakeFile>,
    opts?: SandboxExecOptions,
  ) => SandboxExecChunk[] | undefined;
}

/**
 * In-memory {@link SandboxClient} for tests. No processes, no k8s. It records
 * lifecycle calls (create/destroy) and keeps a per-sandbox file map so hydrate,
 * read, write, and list can be verified deterministically.
 */
export class FakeSandboxClient implements SandboxClient {
  readonly created: string[] = [];
  readonly destroyed: string[] = [];
  private readonly sandboxes = new Map<string, FakeSandbox>();
  private readonly generateId: () => string;
  private readonly execHandler?: FakeSandboxClientOptions["execHandler"];
  private counter = 0;
  /**
   * A monotonic clock for write mtimes. A real filesystem advances a file's
   * mtime on every write, so two writes are never indistinguishable by mtime.
   * `Date.now()` has millisecond resolution and collides when two writes land
   * in the same millisecond (a hydrate + a same-size edit on a fast turn), which
   * would let a size+mtime pre-filter wrongly skip a genuine change. Stamping
   * `max(prevMtime + 1, Date.now())` keeps the fake a faithful stand-in: mtime
   * always strictly advances on a write, never on a read/list.
   */
  private mtimeClock = 0;

  private nextMtime(): number {
    this.mtimeClock = Math.max(this.mtimeClock + 1, Date.now());
    return this.mtimeClock;
  }

  constructor(opts: FakeSandboxClientOptions = {}) {
    this.generateId =
      opts.generateId ?? (() => `sbx-fake-${++this.counter}`);
    this.execHandler = opts.execHandler;
  }

  /** Number of live (created, not destroyed) sandboxes. */
  get liveCount(): number {
    let n = 0;
    for (const s of this.sandboxes.values()) if (!s.destroyed) n++;
    return n;
  }

  /** Inspect a sandbox's files (test helper). */
  filesOf(id: string): Map<string, FakeFile> {
    return this.require(id).files;
  }

  /** Inspect the options a sandbox was created with, e.g. injected env (test helper). */
  createOptsOf(id: string): SandboxCreateOptions {
    const sandbox = this.sandboxes.get(id);
    if (!sandbox) throw new Error(`No sandbox ${id}`);
    return sandbox.createOpts;
  }

  /**
   * Simulate the gateway reclaiming a live sandbox after its lifetime (test
   * helper): the handle stays known but every op against it fails and
   * {@link isAlive} reports false, exactly like a real reclaimed sandbox. This
   * is how tests drive the executor's liveness-rebuild path.
   */
  reclaim(id: string): void {
    const sandbox = this.sandboxes.get(id);
    if (!sandbox) throw new Error(`No sandbox ${id}`);
    sandbox.reclaimed = true;
  }

  async create(opts: SandboxCreateOptions = {}): Promise<SandboxHandle> {
    const id = this.generateId();
    this.sandboxes.set(id, {
      id,
      files: new Map(),
      destroyed: false,
      reclaimed: false,
      createOpts: opts,
    });
    this.created.push(id);
    return { id };
  }

  async *exec(
    id: string,
    command: string[],
    opts?: SandboxExecOptions,
  ): AsyncIterable<SandboxExecChunk> {
    const sandbox = this.require(id);
    const custom = this.execHandler?.(command, sandbox.files, opts);
    if (custom) {
      yield* custom;
      return;
    }
    yield* this.builtinExec(command, sandbox.files);
  }

  async readFile(id: string, path: string): Promise<string> {
    const sandbox = this.require(id);
    const file = sandbox.files.get(path);
    if (!file) throw new Error(`readFile: no such file ${path}`);
    return typeof file.content === "string"
      ? file.content
      : new TextDecoder().decode(file.content);
  }

  async readFileBytes(id: string, path: string): Promise<Uint8Array> {
    const sandbox = this.require(id);
    const file = sandbox.files.get(path);
    if (!file) throw new Error(`readFileBytes: no such file ${path}`);
    return typeof file.content === "string"
      ? new TextEncoder().encode(file.content)
      : new Uint8Array(file.content);
  }

  async writeFile(id: string, path: string, content: string): Promise<void> {
    const sandbox = this.require(id);
    sandbox.files.set(path, { content, mtimeMs: this.nextMtime() });
  }

  async writeFileBytes(
    id: string,
    path: string,
    content: Uint8Array,
  ): Promise<void> {
    const sandbox = this.require(id);
    sandbox.files.set(path, {
      content: new Uint8Array(content),
      mtimeMs: this.nextMtime(),
    });
  }

  async remove(id: string, path: string): Promise<void> {
    const sandbox = this.require(id);
    const base = path.replace(/\/+$/, "") || "/";
    const prefix = base === "/" ? "/" : `${base}/`;
    for (const filePath of [...sandbox.files.keys()]) {
      if (filePath === base || filePath.startsWith(prefix)) {
        sandbox.files.delete(filePath);
      }
    }
  }

  async list(id: string, dir: string): Promise<SandboxFileEntry[]> {
    const sandbox = this.require(id);
    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    const entries: SandboxFileEntry[] = [];
    for (const [path, file] of sandbox.files) {
      if (path === dir || path.startsWith(prefix)) {
        entries.push({
          path,
          size:
            typeof file.content === "string"
              ? Buffer.byteLength(file.content, "utf8")
              : file.content.byteLength,
          mtimeMs: file.mtimeMs,
        });
      }
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return entries;
  }

  async isAlive(id: string): Promise<boolean> {
    const sandbox = this.sandboxes.get(id);
    return sandbox != null && !sandbox.destroyed && !sandbox.reclaimed;
  }

  async destroy(id: string): Promise<void> {
    const sandbox = this.sandboxes.get(id);
    if (!sandbox || sandbox.destroyed) return;
    sandbox.destroyed = true;
    this.destroyed.push(id);
  }

  private *builtinExec(
    command: string[],
    files: Map<string, FakeFile>,
  ): Iterable<SandboxExecChunk> {
    const [cmd, ...args] = command;
    if (cmd === "cat" && args.length > 0) {
      for (const path of args) {
        const file = files.get(path);
        if (file) {
          yield {
            stream: "stdout",
            text:
              typeof file.content === "string"
                ? file.content
                : new TextDecoder().decode(file.content),
          };
        } else {
          yield { stream: "stderr", text: `cat: ${path}: No such file\n` };
        }
      }
      return;
    }
    if (cmd === "echo") {
      yield { stream: "stdout", text: `${args.join(" ")}\n` };
      return;
    }
    // Default: no output (e.g. mkdir -p).
  }

  private require(id: string): FakeSandbox {
    const sandbox = this.sandboxes.get(id);
    if (!sandbox) throw new Error(`No sandbox ${id}`);
    if (sandbox.destroyed) throw new Error(`Sandbox ${id} is destroyed`);
    if (sandbox.reclaimed) throw new Error(`Sandbox ${id} was reclaimed`);
    return sandbox;
  }
}
