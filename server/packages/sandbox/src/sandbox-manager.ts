import type {
  ExecOptions,
  ExecOutputChunk,
  FileListEntry,
  ToolExecutor,
} from "@open-managed-agents/adapter-core";
import type { SandboxClient } from "./sandbox-client.js";
import {
  assertProjectionOutsideWorkspace,
  type ProvisionCoordinate,
  type ProvisionSource,
  type ProjectionTarget,
  type ReadonlyProjection,
} from "./provision-source.js";
import type {
  HydrateTarget,
  HydrationSession,
  SandboxFsAccess,
  SyncResult,
  WorkspacePersistence,
} from "./workspace-persistence.js";

const DEFAULT_WORKSPACE_DIR = "/workspace";

/**
 * Default sandbox lifetime (issue #68). The
 * e2b gateway reclaims a sandbox after this window of inactivity; its own
 * default is short enough that a sandbox is often gone before the next turn's
 * tool call. We pass an explicit, generous lifetime on create so a sandbox
 * survives normal inter-turn think time. A rebuild + re-hydrate + re-project
 * still self-heals a reclaim beyond this window, so this is a comfort margin,
 * not a correctness boundary.
 */
const DEFAULT_SANDBOX_LIFETIME_SECONDS = 60 * 60; // 1 hour

// ─── §1  EnvSpec (the value: Host's recipe, no behavior) ─────────────────────

/**
 * The complete recipe the Host computes and hands to {@link SandboxManager}
 * (design doc §1, CONTEXT.md "Environment Spec"). A **value**, not a behavior:
 * no I/O, no lifecycle. Serializable so adding a projection source never changes
 * this shape (the extensibility bet lives in the weak-typed
 * {@link ProvisionCoordinate}, not here).
 */
export interface EnvSpec {
  tenantId: string;
  workspaceId: string;

  /** Container image / e2b template; falls back to the Manager default. */
  image?: string;
  /** Environment variables baked into the sandbox runtime. */
  env?: Record<string, string>;

  /**
   * The two-way area: hydrated into `workspaceDir`, synced back on every
   * checkpoint and before dispose. Defaults to `/workspace`.
   */
  workspaceDir?: string;

  /**
   * Read-only projections: one-way downward, **never** synced, mounted *outside*
   * `workspaceDir`. Zero or more (design doc §1, ADR-0005 §3).
   */
  projections?: readonly ReadonlyProjection[];
}

// ─── §5  injected seams ──────────────────────────────────────────────────────

/**
 * Everything the {@link SandboxManager} is injected (design doc §5). Three
 * asymmetric extensibility stances (ADR-0005 §2): `sandboxClient` is a true
 * external port (e2b + fake), `persistence` seals the storage **medium** (the
 * one real future bet), and `provisionSources` is a `kind`→adapter dispatch map
 * for read-only projection content.
 */
export interface SandboxManagerDeps {
  /** Low-level sandbox port (e2b in prod, fake in tests). */
  sandboxClient: SandboxClient;
  /** Medium-agnostic Workspace persistence seam (S3 today). */
  persistence: WorkspacePersistence;
  /** Projection sources dispatched by {@link ProvisionCoordinate.kind} (`{ s3 }` today). */
  provisionSources: Record<string, ProvisionSource>;
  /** Manager-wide defaults an EnvSpec may omit. */
  defaults?: { workspaceDir?: string; lifetimeSeconds?: number };
}

// ─── §2  SandboxDescriptor ───────────────────────────────────────────────────

export interface SandboxDescriptor {
  sandboxId: string;
  tenantId: string;
  workspaceId: string;
  createdAtMs: number;
}

/**
 * Thrown by any {@link SandboxSession} primitive called *after* the session was
 * disposed (design doc §3, invariant §7). A disposed session is permanently
 * void — it will not lazily re-create a sandbox, because that would silently
 * leak a sandbox past session end and resurrect state the caller believed gone.
 */
export class SandboxSessionClosed extends Error {
  constructor() {
    super("SandboxSession has been disposed and can no longer be used");
    this.name = "SandboxSessionClosed";
  }
}

// ─── §2  SandboxManager (main path: one door) ────────────────────────────────

/**
 * The single owner of a sandbox's lifecycle, shared by Tool mode and (future)
 * Agent mode (ADR-0005 §1, design doc §2). A small interface that hides
 * create + hydrate + projection orchestration, transparent self-heal, and
 * sync-before-destroy. Per-call isolation: **no cross-session mutable
 * registry** — binding lives in the returned {@link SandboxSession}'s object
 * identity, not in a Map here.
 *
 * `list`/`reclaim` are **reserved — no active sweep is built today** (ADR-0005
 * §Consequences, design doc §7 deletion test): a crash-orphaned sandbox is
 * bounded by the ~1h TTL. They exist so a future sweep can be added without an
 * interface change; deleting them today breaks nothing.
 */
export interface SandboxManager {
  /**
   * Obtain a {@link SandboxSession} bound to this EnvSpec. **Cheap**: starts NO
   * sandbox (lazy — the first primitive triggers create+hydrate+project). A
   * pure-chat turn costs nothing. Two `open`s yield two independent sessions —
   * the binding is in object identity, not a Manager Map.
   *
   * The projection-containment invariant (design doc §1, ADR-0005 §3) is
   * asserted **here**, at open time, because the spec is fully known then:
   * any `projection.targetPath` inside `workspaceDir` fails loud before any
   * sandbox is ever created.
   */
  open(spec: EnvSpec): SandboxSession;

  /** Reserved — no active sweep today (relies on 1h TTL). Returns []. */
  list(filter?: {
    tenantId?: string;
    workspaceId?: string;
  }): Promise<SandboxDescriptor[]>;
  /** Reserved — no active sweep today (relies on 1h TTL). Best-effort destroy. */
  reclaim(sandboxId: string): Promise<void>;
}

// ─── §3  SandboxSession (long-lived, cross-turn, self-healing) ───────────────

/**
 * A Session's live, self-healing binding to its sandbox. **Long-lived across
 * turns**: the Router holds exactly one per Session for its whole lifetime; the
 * sandbox is *not* torn down and rebuilt between turns (it survives on the 1h
 * TTL). Disposed only at session end.
 *
 * Exposes Tool-mode primitives over an always-live handle + checkpoint +
 * dispose. Hides sandboxId, create, hydrate, rebuild, baseline, content-hash
 * state, and the isAlive probe — the Router can never see or misuse them.
 *
 * Structurally an adapter-core {@link ToolExecutor} (identical
 * exec/readFile/writeFile/list signatures), so `AdapterInput.toolExecutor`
 * accepts it directly with no adaptation (proven by the `_assert` below).
 */
export interface SandboxSession {
  // Tool-mode primitives (ADR-0005 §2). Each call transparently self-heals:
  // first call → create+hydrate+project; after a gateway reclaim → rebuild +
  // re-hydrate + re-project. The caller NEVER sees a reclaim error. Paths are
  // workspace-relative; the absolute sandbox path is never exposed.
  exec(command: string[], opts?: ExecOptions): AsyncIterable<ExecOutputChunk>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  list(globOrDir?: string): Promise<FileListEntry[]>;

  /**
   * Turn-end lifecycle checkpoint sync. Returns the delta so the Router can emit
   * `workspace.file_change`. A session that never created a sandbox (pure chat)
   * OR one whose sandbox was reclaimed → **empty** SyncResult, **never throws**,
   * and does NOT create a sandbox just to sync. Only a genuine medium failure
   * throws, for the caller to decide.
   */
  checkpoint(): Promise<SyncResult>;

  /**
   * Session end: sync THEN destroy. Idempotent. A pure-chat session (never
   * created) → empty no-op. After dispose the session is void; any further
   * primitive throws {@link SandboxSessionClosed}.
   */
  dispose(): Promise<SyncResult>;
}

// ─── implementation ──────────────────────────────────────────────────────────

/**
 * The concrete {@link SandboxManager}. Stateless beyond its injected deps and
 * defaults: `open` returns a fresh {@link SandboxSessionImpl}, so two opens are
 * two independent bindings with no shared mutable registry (invariant §2).
 */
export class DefaultSandboxManager implements SandboxManager {
  constructor(private readonly deps: SandboxManagerDeps) {}

  open(spec: EnvSpec): SandboxSession {
    return new SandboxSessionImpl(this.deps, spec);
  }

  /**
   * Reserved (ADR-0005 §Consequences). No cross-session registry exists, so
   * there is nothing to enumerate — a future active sweep would query the
   * gateway. Returns [] today.
   */
  async list(_filter?: {
    tenantId?: string;
    workspaceId?: string;
  }): Promise<SandboxDescriptor[]> {
    return [];
  }

  /**
   * Reserved (ADR-0005 §Consequences). Best-effort destroy of a known id, so a
   * future sweep already has a working teardown hook; `destroy` is idempotent.
   */
  async reclaim(sandboxId: string): Promise<void> {
    await this.deps.sandboxClient.destroy(sandboxId);
  }
}

/**
 * The live, self-healing binding one {@link SandboxManager.open} hands back.
 *
 * Lifecycle state (all private — never surfaced on the interface):
 *  - `sandboxId` / `hydration`: the current live sandbox + the opaque
 *    {@link HydrationSession} threaded from hydrate into sync.
 *  - `ensuring`: memoizes the in-flight create+hydrate+project so concurrent
 *    first callers share one create (lifted from the executor's `ensure`).
 *  - `closed`: set by {@link dispose}; makes the session permanently void.
 *
 * The Tool-mode primitives all resolve a live, hydrated, projected sandbox via
 * {@link ensure} first, so self-heal is transparent on *every* call.
 */
class SandboxSessionImpl implements SandboxSession {
  private readonly sandboxClient: SandboxClient;
  private readonly persistence: WorkspacePersistence;
  private readonly provisionSources: Record<string, ProvisionSource>;
  private readonly tenantId: string;
  private readonly workspaceId: string;
  private readonly workspaceDir: string;
  private readonly image?: string;
  private readonly env?: Record<string, string>;
  private readonly projections: readonly ReadonlyProjection[];
  private readonly lifetimeSeconds: number;

  /** Resolves once the sandbox exists + is hydrated + projected; shared by all callers. */
  private ensuring?: Promise<string>;
  private sandboxId?: string;
  private hydration?: HydrationSession;
  /** Set by {@link dispose}; a closed session refuses every primitive. */
  private closed = false;

  constructor(deps: SandboxManagerDeps, spec: EnvSpec) {
    this.sandboxClient = deps.sandboxClient;
    this.persistence = deps.persistence;
    this.provisionSources = deps.provisionSources;
    this.tenantId = spec.tenantId;
    this.workspaceId = spec.workspaceId;
    this.workspaceDir =
      spec.workspaceDir ?? deps.defaults?.workspaceDir ?? DEFAULT_WORKSPACE_DIR;
    this.image = spec.image;
    this.env = spec.env;
    this.projections = spec.projections ?? [];
    this.lifetimeSeconds =
      deps.defaults?.lifetimeSeconds ?? DEFAULT_SANDBOX_LIFETIME_SECONDS;

    // Fail loud at open time (spec is fully known now): a projection inside the
    // workspace would be swept back as a user artifact (design doc §1,
    // ADR-0005 §3, deletion test §7). Reject before any sandbox is created.
    for (const projection of this.projections) {
      assertProjectionOutsideWorkspace(projection.targetPath, this.workspaceDir);
    }
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
   * Turn-end checkpoint sync (design doc §3). Guards the two empty-no-op cases
   * before touching the medium:
   *
   *  - never created a sandbox (pure chat) → no `sandboxId`/`hydration`;
   *  - sandbox reclaimed by the gateway → `isAlive` is false, and probing it
   *    would throw SandboxNotFoundError, surfacing a spurious sync error.
   *
   * Either way return an EMPTY result without creating a sandbox to sync — the
   * next primitive rebuilds + re-hydrates from the authoritative Workspace. Only
   * a genuine medium failure (from `persistence.sync`) propagates.
   */
  async checkpoint(): Promise<SyncResult> {
    return this.syncBack();
  }

  /**
   * Session end (design doc §3, deletion test §7 "dispose pre-sync is
   * load-bearing"): **sync THEN destroy**, so the last turn's files reach the
   * Workspace before the sandbox is torn down. Idempotent: a second dispose (or
   * a pure-chat dispose) returns an empty no-op. After dispose the session is
   * `closed` — any further primitive throws {@link SandboxSessionClosed}.
   */
  async dispose(): Promise<SyncResult> {
    // Let any in-flight create settle so we don't leak an orphan sandbox.
    if (this.ensuring) {
      try {
        await this.ensuring;
      } catch {
        // create failed; nothing was left running.
      }
    }

    // Sync-before-destroy is the load-bearing step: capture the last turn's
    // delta (empty no-op if never created / reclaimed) while the sandbox is
    // still alive.
    const result = await this.syncBack();

    if (this.sandboxId) {
      const id = this.sandboxId;
      this.sandboxId = undefined;
      this.ensuring = undefined;
      this.hydration = undefined;
      await this.sandboxClient.destroy(id);
    }
    // Void the session last, so the sync above (which used the live sandbox)
    // still ran. From here every primitive throws.
    this.closed = true;
    return result;
  }

  // ─── internals ────────────────────────────────────────────────────────────

  /**
   * Sync the sandbox `workspaceDir` back through the persistence seam, guarding
   * the empty-no-op cases. Shared by {@link checkpoint} and {@link dispose}.
   */
  private async syncBack(): Promise<SyncResult> {
    const empty: SyncResult = {
      tenantId: this.tenantId,
      workspaceId: this.workspaceId,
      changed: [],
      deleted: [],
    };
    if (!this.sandboxId || !this.hydration) return empty;
    const id = this.sandboxId;
    // A reclaimed sandbox holds no state to sync; probing it would throw. Treat
    // it as an empty no-op — the next primitive rebuilds from the Workspace.
    if (!(await this.sandboxClient.isAlive(id))) return empty;
    return this.persistence.sync(this.hydration, this.targetFor(id));
  }

  /**
   * Resolve a live, hydrated, projected sandbox for a primitive — creating one
   * on first use and transparently rebuilding one the gateway has reclaimed
   * (issue #68, ADR-0005 §1, invariants §3/§7).
   *
   * The create+hydrate+project is memoized in {@link ensuring} so concurrent
   * first callers share a single create. A memoized handle can go **stale**
   * (the gateway reclaims after the lifetime), so before reusing it we verify
   * liveness; if dead we drop all sandbox-scoped state and fall through to a
   * fresh create+hydrate+**re-project** — a rebuilt sandbox that skipped
   * re-projection would lose `/skills` (deletion test §7), so re-projection is
   * part of every rebuild, not just re-hydration.
   */
  private async ensure(): Promise<string> {
    // A disposed session never lazily resurrects a sandbox (invariant §5).
    if (this.closed) throw new SandboxSessionClosed();

    if (this.ensuring) {
      const id = await this.ensuring;
      if (await this.sandboxClient.isAlive(id)) return id;
      // Reclaimed by the gateway — drop its state and rebuild below. destroy()
      // is idempotent, so cleaning up a gone sandbox is harmless.
      await this.resetSandboxState(id);
    }
    this.ensuring = this.createHydrateProject();
    return this.ensuring;
  }

  /**
   * Forget a dead sandbox: clear the memoized create, its id, and the in-memory
   * hydration session, then best-effort destroy it. Leaves the session ready to
   * build a fresh sandbox on the next {@link ensure}.
   */
  private async resetSandboxState(id: string): Promise<void> {
    this.ensuring = undefined;
    this.sandboxId = undefined;
    this.hydration = undefined;
    await this.sandboxClient.destroy(id);
  }

  /**
   * The one create path: create the sandbox (with the generous lifetime and
   * tenant/workspace metadata, mirroring the executor), hydrate the Workspace
   * (keeping the opaque {@link HydrationSession}), then project every read-only
   * projection. Projection runs on **every** build — first create and rebuild
   * alike — so a rebuilt sandbox never loses `/skills` (invariant §7).
   */
  private async createHydrateProject(): Promise<string> {
    const handle = await this.sandboxClient.create({
      // Generous explicit lifetime so the sandbox survives normal inter-turn
      // think time (issue #68).
      timeoutSeconds: this.lifetimeSeconds,
      image: this.image,
      env: this.env,
      metadata: {
        "oma.dev/tenant": this.tenantId,
        "oma.dev/workspace": this.workspaceId,
      },
    });
    this.sandboxId = handle.id;
    // 1. Hydrate the two-way Workspace area; keep only the opaque session.
    this.hydration = await this.persistence.hydrate(this.targetFor(handle.id));
    // 2. Project every read-only projection (one-way, outside workspaceDir).
    for (const projection of this.projections) {
      const source = this.provisionSources[projection.source.kind];
      if (!source) {
        throw new Error(
          `No ProvisionSource registered for kind "${projection.source.kind}" ` +
            `(projection target "${projection.targetPath}"); registered kinds: ` +
            `${Object.keys(this.provisionSources).join(", ") || "(none)"}.`,
        );
      }
      await source.project(
        projection.source,
        this.projectionTargetFor(handle.id, projection.targetPath),
      );
    }
    return handle.id;
  }

  /** The hydrate/sync target for a given sandbox id: Workspace coords + fs. */
  private targetFor(id: string): HydrateTarget {
    return {
      tenantId: this.tenantId,
      workspaceId: this.workspaceId,
      workspaceDir: this.workspaceDir,
      fs: this.fsAccessFor(id),
    };
  }

  /** The projection target for a given sandbox id + absolute targetPath. */
  private projectionTargetFor(id: string, targetPath: string): ProjectionTarget {
    return {
      targetPath,
      fs: this.fsAccessFor(id),
      exec: (command, opts) => this.sandboxClient.exec(id, command, opts),
    };
  }

  /**
   * Build a {@link SandboxFsAccess} bound to `id`: the three sandbox-client ops
   * with the sandbox id closed over, so the persistence layer and provision
   * sources work over absolute sandbox paths without ever seeing the backend
   * SDK (same id-bound-closure pattern the executor and #75/#76 used).
   */
  private fsAccessFor(id: string): SandboxFsAccess {
    return {
      writeFile: (path, content) =>
        this.sandboxClient.writeFile(id, path, content),
      readFile: (path) => this.sandboxClient.readFile(id, path),
      list: (dir) => this.sandboxClient.list(id, dir),
    };
  }

  /**
   * Resolve a tool path to an absolute sandbox path, following the
   * sandbox-as-tool convention shared by E2B, opensandbox, and Anthropic's code
   * execution tool: the sandbox is the trust boundary, so paths are taken at
   * face value — no path-level escape guarding.
   *
   * An **absolute** path (leading `/`) is passed through untouched. Callers that
   * speak absolute paths have already chosen their target, which may be
   * *outside* `workspaceDir` — e.g. a Read-only Projection at `/skills/<id>`.
   * The Pi adapter's tools (#80) run with `cwd = /workspace` and hand the
   * executor a Pi-resolved absolute path, so a workspace file arrives as
   * `/workspace/foo` and a projected Skill as `/skills/<id>/SKILL.md`; re-basing
   * either under `workspaceDir` would send reads to `/workspace/skills/…` and
   * make projected Skills unreadable (the invisible-Skill bug).
   *
   * A **relative** path is joined under `workspaceDir` — the workspace is simply
   * the default root for relative access (E2B's persisted workdir plays the same
   * role). This is a convenience default, not a security boundary: `..` is not
   * rejected, because the sandbox — not this string rewrite — is the isolation
   * boundary, and an escaping path only ever reaches other files inside the same
   * disposable sandbox.
   */
  private resolve(path: string): string {
    if (path.startsWith("/")) return path;
    const clean = normalizeRel(path);
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
  // Tidy a relative path for joining under workspaceDir: drop a leading `./`
  // or `/`, and squash empty / `.` segments. No `..` guarding — the sandbox is
  // the trust boundary (see resolve()), so a `..` only reaches another file
  // inside the same disposable sandbox and is left for the OS to resolve.
  const trimmed = path.replace(/^\.\//, "").replace(/^\/+/, "");
  const segments = trimmed.split("/").filter((s) => s !== "" && s !== ".");
  return segments.join("/");
}

/**
 * Minimal glob matcher supporting `*` (non-`/` run) and `**` (any run). Anchored
 * to the whole workspace-relative path. Mirrors the executor's matcher.
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

/**
 * Deletion test §3 (structural): a {@link SandboxSession} IS an adapter-core
 * {@link ToolExecutor}. This assignment fails to compile if the primitive
 * signatures ever drift, guaranteeing `AdapterInput.toolExecutor` accepts a
 * session directly with no adaptation.
 */
const _assertSessionIsToolExecutor = (s: SandboxSession): ToolExecutor => s;
void _assertSessionIsToolExecutor;
