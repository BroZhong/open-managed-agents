import type {
  SandboxClient,
  SandboxCreateOptions,
  SandboxExecChunk,
  SandboxExecOptions,
  SandboxFileEntry,
  SandboxHandle,
} from "./sandbox-client.js";

interface FakeFile {
  content: string;
  mtimeMs: number;
}

interface FakeSandbox {
  id: string;
  files: Map<string, FakeFile>;
  destroyed: boolean;
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

  async create(opts: SandboxCreateOptions = {}): Promise<SandboxHandle> {
    const id = this.generateId();
    this.sandboxes.set(id, {
      id,
      files: new Map(),
      destroyed: false,
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
    return file.content;
  }

  async writeFile(id: string, path: string, content: string): Promise<void> {
    const sandbox = this.require(id);
    sandbox.files.set(path, { content, mtimeMs: Date.now() });
  }

  async list(id: string, dir: string): Promise<SandboxFileEntry[]> {
    const sandbox = this.require(id);
    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    const entries: SandboxFileEntry[] = [];
    for (const [path, file] of sandbox.files) {
      if (path === dir || path.startsWith(prefix)) {
        entries.push({
          path,
          size: Buffer.byteLength(file.content, "utf8"),
          mtimeMs: file.mtimeMs,
        });
      }
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return entries;
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
          yield { stream: "stdout", text: file.content };
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
    return sandbox;
  }
}
