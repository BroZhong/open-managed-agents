import type {
  ExecOptions,
  ExecOutputChunk,
  FileListEntry,
  ToolExecutor,
} from "@open-managed-agents/adapter-core";
import type { ArtifactStore } from "@oma-server/store";
import type {
  SandboxClient,
  SandboxCreateOptions,
} from "./sandbox-client.js";
import { contentHash, type WorkspaceSyncResult } from "./workspace-sync.js";

const DEFAULT_WORKSPACE_DIR = "/workspace";

export interface SandboxToolExecutorOptions {
  /** Low-level sandbox port (kruise in prod, fake in tests). */
  sandboxClient: SandboxClient;
  /** S3-authoritative artifact store the Workspace lives in. */
  artifactStore: ArtifactStore;
  /** Tenant that owns the bound Workspace. */
  tenantId: string;
  /** The Workspace this executor is bound to. */
  workspaceId: string;
  /** Absolute sandbox dir the Workspace hydrates into. Defaults to `/workspace`. */
  workspaceDir?: string;
  /** Passed through to `sandboxClient.create` (image, env, timeout). */
  createOptions?: SandboxCreateOptions;
}

/**
 * Sandbox-backed {@link ToolExecutor} bound to a single Workspace.
 *
 * Per ADR-0002 §4 this is the concrete executor the Host injects per `run()`
 * call. Its defining behaviors:
 *
 *  - **Lazy create**: no sandbox is created in the constructor. The first
 *    filesystem/code operation (`exec`/`readFile`/`writeFile`/`list`) triggers
 *    a single create — so a pure-chat turn (which never touches the executor)
 *    spins up nothing.
 *  - **Hydrate**: immediately after create, the sandbox `/workspace` is
 *    populated from the Workspace's S3 contents (the hydrate baseline).
 *  - **Destroy**: {@link dispose} tears the sandbox down; the Host calls it at
 *    session end.
 *
 * All executor paths are workspace-relative and resolved under
 * `workspaceDir` — the Adapter never sees an absolute sandbox path.
 *
 * **Sync-back (#43, ADR-0002 §4)** is owned here and invisible to the Adapter.
 * {@link sync} does a full `/workspace` scan (so shell-created files are
 * caught), pushes only content-changed/new files (hash, not size), and deletes
 * from S3 only files present in *this* sandbox's hydrate baseline that are now
 * absent — so a concurrent session's newly added files are never deleted. The
 * Host calls {@link sync} at tool-execution points and emits the resulting
 * `workspace.file_change` event; the executor itself emits nothing.
 */
export class SandboxToolExecutor implements ToolExecutor {
  private readonly sandboxClient: SandboxClient;
  private readonly artifactStore: ArtifactStore;
  private readonly tenantId: string;
  private readonly workspaceId: string;
  private readonly workspaceDir: string;
  private readonly createOptions: SandboxCreateOptions;

  /** Resolves once the sandbox exists + is hydrated; shared by all callers. */
  private ensuring?: Promise<string>;
  private sandboxId?: string;
  /**
   * Paths (workspace-relative) hydrated from S3 on create. Kept in Host memory
   * for the sandbox lifetime as the **deletion baseline**: sync deletes from S3
   * only paths in this set that later go missing, so files added by a
   * concurrent session (never in this baseline) are never deleted. Discarded
   * when the sandbox is destroyed (see {@link dispose}).
   */
  private hydrateBaseline: string[] = [];
  /**
   * Content hash of every path currently believed to be in S3, keyed by
   * workspace-relative path. Seeded from the hydrate contents and updated on
   * every push/delete, this is the **content-hash comparison** state: sync
   * pushes a scanned file only when its hash differs from (or is absent in)
   * this map, so a same-size edit is still synced.
   */
  private s3State = new Map<string, string>();

  constructor(opts: SandboxToolExecutorOptions) {
    this.sandboxClient = opts.sandboxClient;
    this.artifactStore = opts.artifactStore;
    this.tenantId = opts.tenantId;
    this.workspaceId = opts.workspaceId;
    this.workspaceDir = opts.workspaceDir ?? DEFAULT_WORKSPACE_DIR;
    this.createOptions = opts.createOptions ?? {};
  }

  /** True once a sandbox has actually been created (test/introspection aid). */
  get created(): boolean {
    return this.sandboxId != null;
  }

  /** The hydrate baseline captured on create (empty until first tool use). */
  get baseline(): readonly string[] {
    return this.hydrateBaseline;
  }

  async *exec(
    command: string[],
    opts?: ExecOptions,
  ): AsyncIterable<ExecOutputChunk> {
    const id = await this.ensure();
    const cwd = this.resolve(opts?.cwd ?? ".");
    yield* this.sandboxClient.exec(id, command, {
      cwd,
      timeoutSeconds: opts?.timeoutSeconds,
      env: opts?.env,
    });
  }

  async readFile(path: string): Promise<string> {
    const id = await this.ensure();
    return this.sandboxClient.readFile(id, this.resolve(path));
  }

  async writeFile(path: string, content: string): Promise<void> {
    const id = await this.ensure();
    await this.sandboxClient.writeFile(id, this.resolve(path), content);
  }

  async list(globOrDir?: string): Promise<FileListEntry[]> {
    const id = await this.ensure();
    const dir = this.resolve(
      globOrDir && !globOrDir.includes("*") ? globOrDir : ".",
    );
    const pattern =
      globOrDir && globOrDir.includes("*") ? globOrDir : undefined;
    const entries = await this.sandboxClient.list(id, dir);
    return entries
      .map((e) => ({
        path: this.toRelative(e.path),
        size: e.size,
        mtimeMs: e.mtimeMs,
      }))
      .filter((e) => !pattern || matchGlob(pattern, e.path));
  }

  /**
   * Destroy the sandbox at session end. Idempotent. If no sandbox was ever
   * created (pure-chat session), this is a no-op — nothing to tear down.
   */
  async dispose(): Promise<void> {
    if (this.ensuring) {
      // Let any in-flight create settle so we don't leak an orphan sandbox.
      try {
        await this.ensuring;
      } catch {
        // create failed; nothing was left running.
      }
    }
    if (this.sandboxId) {
      const id = this.sandboxId;
      this.sandboxId = undefined;
      this.ensuring = undefined;
      // The hydrate baseline lives in Host memory only for the sandbox's
      // lifetime; discard it (and the S3 hash state) on destroy (ADR-0002 §4).
      this.hydrateBaseline = [];
      this.s3State.clear();
      await this.sandboxClient.destroy(id);
    }
  }

  // ─── internals ────────────────────────────────────────────────────────────

  /** Create-and-hydrate exactly once, memoized across concurrent callers. */
  private ensure(): Promise<string> {
    if (this.ensuring) return this.ensuring;
    this.ensuring = this.createAndHydrate();
    return this.ensuring;
  }

  private async createAndHydrate(): Promise<string> {
    const handle = await this.sandboxClient.create({
      ...this.createOptions,
      metadata: {
        ...(this.createOptions.metadata ?? {}),
        "oma.dev/tenant": this.tenantId,
        "oma.dev/workspace": this.workspaceId,
      },
    });
    this.sandboxId = handle.id;
    await this.hydrate(handle.id);
    return handle.id;
  }

  private async hydrate(id: string): Promise<void> {
    const artifacts = await this.artifactStore.list(
      this.tenantId,
      this.workspaceId,
    );
    const baseline: string[] = [];
    for (const artifact of artifacts) {
      const content = await this.artifactStore.get(
        this.tenantId,
        this.workspaceId,
        artifact.path,
      );
      if (!content) continue;
      const text = new TextDecoder().decode(content.body);
      await this.sandboxClient.writeFile(id, this.resolve(artifact.path), text);
      const rel = normalizeRel(artifact.path);
      baseline.push(rel);
      // Seed the content-hash comparison state: what is already in S3 right now.
      this.s3State.set(rel, contentHash(text));
    }
    baseline.sort();
    this.hydrateBaseline = baseline;
  }

  /**
   * Sync the sandbox `/workspace` back to the S3 Workspace (ADR-0002 §4). Runs
   * at tool-execution points, driven by the Host. Steps:
   *
   *  1. **Full scan** — list every file under `/workspace` (`sandboxClient.list`
   *     is recursive), so files created by *any* means (bash, a write tool, a
   *     compiler) are captured, not just those written through this executor.
   *  2. **Content-hash push** — read each scanned file, hash its content, and
   *     push to S3 only when the hash is new or differs from the last known S3
   *     hash. Same-size edits still differ by hash, so they are synced.
   *  3. **Baseline-diff deletion** — delete from S3 only paths present in this
   *     sandbox's hydrate baseline that are now absent from the scan. Paths
   *     added by a concurrent session are not in this baseline, so they are
   *     never deleted.
   *
   * A pure-chat session that never created a sandbox syncs to an empty result.
   */
  async sync(): Promise<WorkspaceSyncResult> {
    const empty: WorkspaceSyncResult = {
      tenantId: this.tenantId,
      workspaceId: this.workspaceId,
      changed: [],
      deleted: [],
    };
    if (!this.sandboxId) return empty;
    const id = this.sandboxId;

    // 1. Full recursive scan of /workspace → workspace-relative paths.
    const entries = await this.sandboxClient.list(id, this.workspaceDir);
    const present = new Set<string>();
    const changed: string[] = [];

    // 2. Content-hash comparison — push only new/changed files.
    for (const entry of entries) {
      const rel = this.toRelative(entry.path);
      if (rel === "") continue;
      present.add(rel);
      const text = await this.sandboxClient.readFile(id, entry.path);
      const hash = contentHash(text);
      if (this.s3State.get(rel) === hash) continue; // unchanged — skip.
      await this.artifactStore.put({
        tenantId: this.tenantId,
        workspaceId: this.workspaceId,
        path: rel,
        body: text,
      });
      this.s3State.set(rel, hash);
      changed.push(rel);
    }

    // 3. Baseline-diff deletion — only hydrated paths now missing.
    const deleted: string[] = [];
    for (const rel of this.hydrateBaseline) {
      if (present.has(rel)) continue;
      const existed = await this.artifactStore.delete(
        this.tenantId,
        this.workspaceId,
        rel,
      );
      this.s3State.delete(rel);
      if (existed) deleted.push(rel);
    }

    changed.sort();
    deleted.sort();
    return { tenantId: this.tenantId, workspaceId: this.workspaceId, changed, deleted };
  }

  /** Resolve a workspace-relative path to an absolute sandbox path. */
  private resolve(rel: string): string {
    const clean = normalizeRel(rel);
    return clean ? `${this.workspaceDir}/${clean}` : this.workspaceDir;
  }

  /** Turn an absolute sandbox path back into a workspace-relative path. */
  private toRelative(abs: string): string {
    const prefix = `${this.workspaceDir}/`;
    if (abs === this.workspaceDir) return "";
    return abs.startsWith(prefix) ? abs.slice(prefix.length) : abs;
  }
}

/** Strip leading `./` and `/`, and reject `..` traversal out of the workspace. */
function normalizeRel(path: string): string {
  const trimmed = path.replace(/^\.\//, "").replace(/^\/+/, "");
  const segments = trimmed.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) {
    throw new Error(`path escapes workspace: ${path}`);
  }
  return segments.join("/");
}

/**
 * Minimal glob matcher supporting `*` (non-`/` run) and `**` (any run). Anchored
 * to the whole workspace-relative path. Mirrors the local executor's matcher.
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
