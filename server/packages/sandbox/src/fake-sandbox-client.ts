import { createHash } from "node:crypto";
import { SANDBOX_WORKSPACE_ROOT, ExecAbortedBeforeStartError } from "@open-managed-agents/adapter-core";
import { unpackSkillBundle } from "@oma-server/store";
import {
  isSkillInstallCommand,
  SKILL_INSTALL_PROTOCOL,
  SKILLS_PATH,
  type SkillInstallStage,
} from "./skill-install.js";
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
  /** Unix permission bits, where a writer set them (the Skill Install). */
  mode?: number;
}

/** The emulated `/opt/oma/skills` of one Sandbox. */
interface FakeSkills {
  /** Extracted bundles by sha256: Skill-relative path → bytes and installed mode. */
  bundles: Map<string, Map<string, { body: Uint8Array; mode: number }>>;
  /** Complete version directories by Skill Set hash, with the bundles they reference. */
  versions: Map<string, { tree: Map<string, FakeFile>; bundles: Set<string> }>;
  /** The version `/skills` points at. */
  current?: string;
  /** The install lock (flock). */
  lock: Promise<void>;
}

/**
 * Fault injection into the emulated Skill Install, consulted as it enters
 * each stage of the script. A thrown error fails the install at that stage;
 * a promise that settles only on `signal` abort models a hung install.
 */
export type FakeSkillInstallFault = (stage: SkillInstallStage, signal?: AbortSignal) => void | Promise<void>;

interface FakeSandbox {
  id: string;
  files: Map<string, FakeFile>;
  destroyed: boolean;
  /**
   * Simulates the gateway reclaiming a sandbox after its lifetime: the handle
   * is still known here but no longer live. Ops against it fail as they would
   * against a real reclaimed sandbox, and {@link state} reports false — this
   * is the seam tests use to exercise the executor's liveness-rebuild path.
   */
  reclaimed: boolean;
  paused?: boolean;
  createOpts: SandboxCreateOptions;
  mount?: WorkspaceMountTarget;
  mountFailure?: string;
  skills: FakeSkills;
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
  resetExecutionUncertainty(_id: string): void {}
  readonly deadlines: Array<{ id: string; seconds: number }> = [];
  async setTimeout(id: string, seconds: number): Promise<void> { this.require(id); this.deadlines.push({ id, seconds }); }
  pause(id: string): void { this.require(id).paused = true; }
  async state(id: string): Promise<'running' | 'paused' | 'missing'> {
    const sandbox = this.sandboxes.get(id);
    if (!sandbox || sandbox.destroyed || sandbox.reclaimed) return 'missing';
    return sandbox.paused ? 'paused' : 'running';
  }
  async reconnect(id: string, _metadata: Record<string, string>): Promise<boolean> {
    if (await this.state(id) === 'missing') return false;
    this.sandboxes.get(id)!.paused = false;
    await this.setTimeout(id, 86400);
    return true;
  }
  readonly created: string[] = [];
  readonly destroyed: string[] = [];
  private readonly sandboxes = new Map<string, FakeSandbox>();
  private readonly workspaces = new Map<string, Map<string, FakeFile>>();
  readonly mountChecks: Array<{ id: string; target: WorkspaceMountTarget }> =
    [];
  private readonly generateId: () => string;
  private readonly execHandler?: FakeSandboxClientOptions["execHandler"];
  /** See {@link FakeSkillInstallFault}. */
  skillInstallFault?: FakeSkillInstallFault;
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
   * {@link state} reports false, exactly like a real reclaimed sandbox. This
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
      skills: { bundles: new Map(), versions: new Map(), lock: Promise.resolve() },
    });
    this.created.push(id);
    return { id };
  }

  /** Fault injection at the same mount verification port production uses. */
  setMountFailure(id: string, reason?: string): void {
    this.sandboxes.get(id)!.mountFailure = reason;
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
    if (opts?.signal?.aborted) throw new ExecAbortedBeforeStartError();
    const sandbox = this.require(id);
    if (isSkillInstallCommand(command)) {
      yield* this.installSkills(sandbox, opts);
      return;
    }
    const custom = this.execHandler?.(command, sandbox.files, opts);
    if (custom) {
      yield* custom;
      opts?.onExit?.({ exitCode: 0 });
      return;
    }
    yield* this.builtinExec(command, sandbox.files);
    opts?.onExit?.({ exitCode: 0 });
  }

  async readFile(id: string, path: string): Promise<string> {
    const sandbox = this.require(id);
    const file = sandbox.files.get(path);
    if (!file) throw Object.assign(new Error(`readFile: no such file ${path}`), { code: "ENOENT" });
    return typeof file.content === "string"
      ? file.content
      : new TextDecoder().decode(file.content);
  }

  async readFileBytes(id: string, path: string): Promise<Uint8Array> {
    const sandbox = this.require(id);
    const file = sandbox.files.get(path);
    if (!file) throw Object.assign(new Error(`readFileBytes: no such file ${path}`), { code: "ENOENT" });
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

  async destroy(id: string): Promise<void> {
    const sandbox = this.sandboxes.get(id);
    if (!sandbox || sandbox.destroyed) return;
    sandbox.destroyed = true;
    this.destroyed.push(id);
  }

  /**
   * Simulate a Sandbox prepared by an earlier Runner's Read-only Projection
   * (test helper): `/skills` is a real directory holding these files and no
   * Skill Install ran yet.
   */
  seedProjectedSkills(id: string, files: Record<string, string>): void {
    const sandbox = this.require(id);
    for (const path of [...sandbox.files.keys()]) if (path.startsWith(`${SKILLS_PATH}/`)) sandbox.files.delete(path);
    sandbox.skills = { bundles: new Map(), versions: new Map(), lock: sandbox.skills.lock };
    for (const [path, content] of Object.entries(files)) sandbox.files.set(path, { content, mtimeMs: this.nextMtime() });
  }

  /** Version directories the emulated `/opt/oma/skills` holds (test helper). */
  skillVersionsOf(id: string): string[] {
    return [...this.require(id).skills.versions.keys()].sort();
  }

  /** Extracted bundles the emulated `/opt/oma/skills/bundles` holds (test helper). */
  skillBundlesOf(id: string): string[] {
    return [...this.require(id).skills.bundles.keys()].sort();
  }

  /**
   * Emulates `skill-install.sh` over the same stdin protocol and output: the
   * lock, the per-bundle cache, download through the signed URL (the
   * in-memory bundle store's `data:` URLs), sha256 verification, read-only
   * modes and an atomic `/skills` switch that replaces a projected directory.
   */
  private async *installSkills(sandbox: FakeSandbox, opts?: SandboxExecOptions): AsyncIterable<SandboxExecChunk> {
    const signal = opts?.signal;
    let stage: SkillInstallStage = "start";
    const line = (text: string): SandboxExecChunk => ({ stream: "stdout", text: `${text}\n` });
    // The script announces a stage before working in it.
    const enter = (next: SkillInstallStage) => {
      stage = next;
      return line(`OMA_SKILLS_STAGE ${next}`);
    };
    const work = async () => {
      await this.skillInstallFault?.(stage, signal);
      if (signal?.aborted) throw signal.reason;
    };
    const failure = (reason: string) => line(`OMA_SKILLS_RESULT ${JSON.stringify({ ok: false, stage, reason })}`);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const previousHolder = sandbox.skills.lock;
    sandbox.skills.lock = previousHolder.then(() => held);
    try {
      yield enter("start");
      await work();
      const request = parseInstallRequest(opts?.stdin);
      if (typeof request === "string") { yield failure(request); opts?.onExit?.({ exitCode: 1 }); return; }
      await previousHolder;
      const skills = sandbox.skills;
      let reused = 1, downloaded = 0, bytes = 0;
      if (!skills.versions.has(request.setHash)) {
        reused = 0;
        const missing = [...new Set(request.records.map((record) => record.sha256))].filter((sha) => !skills.bundles.has(sha));
        const fetched = new Map<string, Uint8Array>();
        if (missing.length) {
          let problem: { stage: SkillInstallStage; reason: string } | undefined;
          for (let round = 1; round <= 2 && fetched.size < missing.length; round++) {
            yield enter("download");
            await work();
            const results = new Map<string, Uint8Array | string>();
            for (const sha of missing.filter((sha) => !fetched.has(sha))) {
              results.set(sha, await download(request.records.find((record) => record.sha256 === sha)!.url));
            }
            yield enter("verify");
            await work();
            problem = undefined;
            for (const [sha, body] of results) {
              if (typeof body === "string") problem = { stage: "download", reason: `${body} for bundle ${sha.slice(0, 12)}` };
              else if (createHash("sha256").update(body).digest("hex") !== sha) problem = { stage: "verify", reason: `sha256 mismatch for bundle ${sha.slice(0, 12)}` };
              else fetched.set(sha, body);
            }
          }
          if (problem && fetched.size < missing.length) { stage = problem.stage; yield failure(problem.reason); opts?.onExit?.({ exitCode: 1 }); return; }
        }
        yield enter("extract");
        await work();
        const extracted = new Map<string, Map<string, { body: Uint8Array; mode: number }>>();
        for (const [sha, zip] of fetched) {
          const files = await unpackSkillBundle(zip);
          extracted.set(sha, new Map(files.map((file) => [file.path, { body: file.body, mode: file.mode & 0o111 ? 0o555 : 0o444 }])));
          bytes += zip.byteLength;
          downloaded++;
        }
        for (const [sha, files] of extracted) skills.bundles.set(sha, files);
        const tree = new Map<string, FakeFile>();
        for (const { name, sha256 } of request.records) {
          for (const [path, file] of skills.bundles.get(sha256)!) {
            tree.set(`${SKILLS_PATH}/${name}/${path}`, { content: file.body, mode: file.mode, mtimeMs: this.nextMtime() });
          }
        }
        skills.versions.set(request.setHash, { tree, bundles: new Set(request.records.map((record) => record.sha256)) });
      }
      yield enter("switch");
      await work();
      const previous = skills.current;
      const legacy = previous === undefined && [...sandbox.files.keys()].some((path) => path.startsWith(`${SKILLS_PATH}/`)) ? 1 : 0;
      // One synchronous replacement: a reader sees the old tree or the new one.
      for (const path of [...sandbox.files.keys()]) if (path.startsWith(`${SKILLS_PATH}/`)) sandbox.files.delete(path);
      for (const [path, file] of skills.versions.get(request.setHash)!.tree) sandbox.files.set(path, { ...file });
      skills.current = request.setHash;
      if (previous !== request.setHash) {
        for (const version of [...skills.versions.keys()]) if (version !== request.setHash && version !== previous) skills.versions.delete(version);
        const referenced = new Set([...skills.versions.values()].flatMap((version) => [...version.bundles]));
        for (const sha of [...skills.bundles.keys()]) if (!referenced.has(sha)) skills.bundles.delete(sha);
      }
      yield line(`OMA_SKILLS_RESULT ${JSON.stringify({ ok: true, stage: "done", reused, skills: request.records.length, downloaded, bytes, legacy })}`);
      opts?.onExit?.({ exitCode: 0 });
    } catch (error) {
      if (signal?.aborted) {
        // A budget abort kills the installer, as the E2B client does.
        opts?.onExit?.({ exitCode: null, signal: "SIGKILL" });
        throw new DOMException("Command aborted", "AbortError");
      }
      yield failure(error instanceof Error ? error.message : String(error));
      opts?.onExit?.({ exitCode: 1 });
    } finally {
      release();
    }
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
    if (sandbox.paused) throw new Error(`Sandbox ${id} is paused`);
    if (sandbox.mountFailure) throw new WorkspaceMountUnavailable();
    if (sandbox.reclaimed) throw new Error(`Sandbox ${id} was reclaimed`);
    return sandbox;
  }
}

interface InstallRequest {
  setHash: string;
  records: Array<{ sha256: string; name: string; url: string }>;
}

/** The script's request validation; a string is its failure reason. */
function parseInstallRequest(stdin: string | undefined): InstallRequest | string {
  const lines = (stdin ?? "").split("\n");
  const [magic, setHash, count, budget] = (lines[0] ?? "").split(" ");
  if (magic !== SKILL_INSTALL_PROTOCOL || !/^[0-9a-f]{64}$/.test(setHash ?? "") || !/^(0|[1-9][0-9]{0,3})$/.test(count ?? "") || !/^[1-9][0-9]{0,4}$/.test(budget ?? "")) {
    return stdin ? "malformed install request" : "no install request arrived on stdin";
  }
  const records: InstallRequest["records"] = [];
  for (let index = 1; index <= Number(count); index++) {
    const [sha256, name64, url] = (lines[index] ?? "").split(" ");
    if (!/^[0-9a-f]{64}$/.test(sha256 ?? "") || !/^[A-Za-z0-9+/]+=*$/.test(name64 ?? "") || !url) return "malformed install record";
    const name = Buffer.from(name64, "base64").toString("utf8");
    if (!name || name === "." || name === ".." || name.includes("/") || /[\u0000-\u001f\u007f]/.test(name) || records.some((record) => record.name === name)) {
      return "invalid or duplicate Skill name";
    }
    records.push({ sha256, name, url });
  }
  return { setHash, records };
}

/** The bytes behind an install URL, or the failure the script would report. */
async function download(url: string): Promise<Uint8Array | string> {
  // Only the in-memory store's data: URLs resolve offline; anything else is unreachable here.
  if (!url.startsWith("data:")) return "HTTP 000, curl exit 6";
  try {
    const response = await fetch(url);
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : `HTTP ${response.status}, curl exit 0`;
  } catch {
    return "HTTP 000, curl exit 3";
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
