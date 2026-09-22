import { SANDBOX_WORKSPACE_ROOT } from "@open-managed-agents/adapter-core";
import {
  WorkspaceMountUnavailable,
  type WorkspaceMountTarget,
} from "./workspace-mount.js";
import type {
  SandboxClient,
  SandboxCreateOptions,
  SandboxExecChunk,
  SandboxExecOptions,
  SandboxFileEntry,
  SandboxHandle,
} from "./sandbox-client.js";

export interface FakeFile {
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
  mount?: WorkspaceMountTarget;
  mountFailure?: string;
}

/**
 * A custom command handler for the fake, keyed by the first argv element.
 * Receives the argv and the sandbox's in-memory file map and returns the
 * chunks to stream back. Lets tests simulate a tool reading a mounted file
 * (e.g. `cat /home/user/foo.txt`) without any real process.
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
 * lifecycle calls (create/destroy) and keeps a per-sandbox file map with a shared mounted subtree so reads, writes and rebuilds can be tested.
 */
export class FakeSandboxClient implements SandboxClient {
  /** All fake operations settle in-process; there is no remote command to lose. */
  hasUncertainExecution(_id: string): boolean { return false; }
  readonly created: string[] = [];
  readonly destroyed: string[] = [];
  private readonly sandboxes = new Map<string, FakeSandbox>();
  private readonly workspaces = new Map<string, Map<string, FakeFile>>();
  readonly mountChecks: Array<{ id: string; target: WorkspaceMountTarget }> =
    [];
  private readonly generateId: () => string;
  private readonly execHandler?: FakeSandboxClientOptions["execHandler"];
  private counter = 0;
  /** Monotonic timestamps make successive writes observable in file listings. */
  private mtimeClock = 0;

  private nextMtime(): number {
    this.mtimeClock = Math.max(this.mtimeClock + 1, Date.now());
    return this.mtimeClock;
  }

  constructor(opts: FakeSandboxClientOptions = {}) {
    this.generateId = opts.generateId ?? (() => `sbx-fake-${++this.counter}`);
    this.execHandler = opts.execHandler;
  }

  /** Number of live (created, not destroyed) sandboxes. */
  get liveCount(): number {
    let n = 0;
    for (const s of this.sandboxes.values()) if (!s.destroyed) n++;
    return n;
  }

  /** Simulate a Host write into the authoritative mounted prefix. */
  seedWorkspace(
    prefix: string,
    path: string,
    content: string | Uint8Array,
  ): void {
    let files = this.workspaces.get(prefix);
    if (!files) this.workspaces.set(prefix, (files = new Map()));
    files.set(`${SANDBOX_WORKSPACE_ROOT}/${path}`, {
      content: typeof content === "string" ? content : new Uint8Array(content),
      mtimeMs: this.nextMtime(),
    });
  }

  /** Relative-path snapshot of persisted content, including after destruction. */
  workspaceContents(prefix: string): Map<string, FakeFile> {
    return new Map(
      [...(this.workspaces.get(prefix) ?? [])].map(([path, file]) => [
        path.slice(SANDBOX_WORKSPACE_ROOT.length + 1),
        file,
      ]),
    );
  }

  deleteWorkspaceFile(prefix: string, path: string): void {
    this.workspaces.get(prefix)?.delete(`${SANDBOX_WORKSPACE_ROOT}/${path}`);
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
    const volume = JSON.parse(
      opts.metadata?.["e2b.agents.kruise.io/csi-volume-config"] ?? "[]",
    )[0];
    const prefix = volume ? `${volume.subPath}/` : undefined;
    let shared: Map<string, FakeFile> | undefined;
    if (prefix) {
      shared = this.workspaces.get(prefix);
      if (!shared) this.workspaces.set(prefix, (shared = new Map()));
    }
    this.sandboxes.set(id, {
      id,
      files:
        volume && shared
          ? new MountedFiles(volume.mountPath, shared)
          : new Map(),
      ...(volume
        ? {
            mount: {
              mountPath: volume.mountPath,
              prefix: prefix!,
              bucket: "agentry",
            },
          }
        : {}),
      destroyed: false,
      reclaimed: false,
      createOpts: opts,
    });
    this.created.push(id);
    return { id };
  }

  /** Fault injection at the same mount verification port production uses. */
  setMountFailure(id: string, reason?: string): void {
    this.require(id).mountFailure = reason;
  }

  setMountIdentity(id: string, target: WorkspaceMountTarget): void {
    this.require(id).mount = target;
  }

  async verifyWorkspaceMount(
    id: string,
    target: WorkspaceMountTarget,
  ): Promise<void> {
    const sandbox = this.require(id);
    this.mountChecks.push({ id, target });
    if (
      sandbox.mountFailure ||
      !sandbox.mount ||
      sandbox.mount.mountPath !== target.mountPath ||
      sandbox.mount.prefix !== target.prefix ||
      sandbox.mount.bucket !== target.bucket
    )
      throw new WorkspaceMountUnavailable();
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

/** A mounted subtree shares its backing map; HOME and Skills remain per-instance. */
class MountedFiles extends Map<string, FakeFile> {
  private readonly local = new Map<string, FakeFile>();
  constructor(
    private readonly root: string,
    private readonly mounted: Map<string, FakeFile>,
  ) {
    super();
  }
  private map(path: string): Map<string, FakeFile> {
    return path.startsWith(`${this.root}/`) ? this.mounted : this.local;
  }
  override get(path: string): FakeFile | undefined {
    return this.map(path).get(path);
  }
  override set(path: string, value: FakeFile): this {
    this.map(path).set(path, value);
    return this;
  }
  override has(path: string): boolean {
    return this.map(path).has(path);
  }
  override delete(path: string): boolean {
    return this.map(path).delete(path);
  }
  override get size(): number {
    return this.local.size + this.mounted.size;
  }
  override clear(): void {
    this.local.clear();
    this.mounted.clear();
  }
  override entries(): MapIterator<[string, FakeFile]> {
    return new Map([...this.local, ...this.mounted]).entries();
  }
  override keys(): MapIterator<string> {
    return new Map([...this.local, ...this.mounted]).keys();
  }
  override values(): MapIterator<FakeFile> {
    return new Map([...this.local, ...this.mounted]).values();
  }
  override [Symbol.iterator](): MapIterator<[string, FakeFile]> {
    return this.entries();
  }
}
