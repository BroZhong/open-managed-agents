import type { SkillArtifactStore } from "@oma-server/store";
import type {
  SandboxExecChunk,
  SandboxExecOptions,
} from "./sandbox-client.js";
import type { SandboxFsAccess } from "./workspace-persistence.js";

/**
 * A single **Read-only Projection** (a value; CONTEXT.md "Read-only Projection",
 * design doc §1, ADR-0005 §3). External content projected into a sandbox path
 * *outside* the Workspace — equipped Skills, a checked-out code repo, a preloaded
 * dataset. One-way, downward only; **never** synced back. Distinguished from a
 * Workspace by a single axis: it is never written back.
 *
 * `source` is a coordinate, not content: the I/O is performed by the injected
 * {@link ProvisionSource} selected by {@link ProvisionCoordinate.kind}. Content
 * flows source → sandbox directly (S3 today), never routed through the Host — the
 * Host supplies only the coordinate.
 */
export interface ReadonlyProjection {
  /**
   * Absolute sandbox path the content lands at (e.g. `/skills/<id>`, `/repo`).
   * **MUST** lie outside the Workspace's `workspaceDir`, so the Workspace sync's
   * full scan never mistakes it for a user-created artifact and writes it back
   * (the invariant enforced by {@link assertProjectionOutsideWorkspace}).
   */
  targetPath: string;
  source: ProvisionCoordinate;
}

/**
 * A weak-typed coordinate for where a projection's content comes from
 * (design doc §1, decision summary). Deliberately `{ kind, ref }` rather than a
 * strongly-typed discriminated union: this keeps {@link ReadonlyProjection} — and
 * therefore the whole EnvSpec — a plain serializable value, and makes adding a new
 * source a *closed* change: register a new adapter under a new `kind`, with zero
 * change to the core types. Dispatch by `kind` to a registered {@link ProvisionSource}.
 */
export interface ProvisionCoordinate {
  /** Selects the {@link ProvisionSource} adapter. `"s3"` today; future `"git"` | `"tarball"`. */
  kind: string;
  /**
   * Source-specific address, intentionally weak-typed (`Record<string, string>`)
   * so a new `kind` needs no core-type change. Its shape is a private contract
   * between the Host (which fills it) and the adapter for that `kind` (which reads
   * it). For `kind: "s3"` see {@link S3ProvisionSource} for the accepted shape.
   */
  ref: Record<string, string>;
}

/**
 * The one-way source of a **Read-only Projection**'s content (CONTEXT.md
 * "Provision Source", design doc §5). Sealed behind this seam so the projection
 * mechanism is indifferent to *where* content comes from: S3 today; a git clone or
 * a tarball fetch would each be another `kind` + adapter. The extension unit is a
 * single method — implement `project`, register the adapter under its `kind`.
 *
 * Adding a source touches nothing else: the future SandboxManager holds a
 * `Record<string, ProvisionSource>` keyed by `kind` and dispatches to it
 * (design doc §5); #76 supplies the interface plus the S3 and Fake adapters.
 */
export interface ProvisionSource {
  /**
   * Read the content addressed by `coord` and write it into the sandbox at
   * `target.targetPath` via `target.fs`/`target.exec`. One-way: the source is
   * never read back from the sandbox. Content must never be routed through the
   * Host — an adapter reads its medium and writes straight into the sandbox.
   */
  project(coord: ProvisionCoordinate, target: ProjectionTarget): Promise<void>;
}

/**
 * The minimal sandbox write capability a {@link ProvisionSource} is handed, with
 * the backend sandbox `id` already bound by the caller (mirrors
 * {@link import("./workspace-persistence.js").HydrateTarget} for the Workspace
 * side). The adapter never learns which backend (e2b, a fake, …) it talks to.
 */
export interface ProjectionTarget {
  /**
   * Absolute sandbox path to write into. **MUST** be outside the Workspace — the
   * caller (future SandboxManager, which knows `workspaceDir`) is responsible for
   * asserting this via {@link assertProjectionOutsideWorkspace} before projecting.
   */
  targetPath: string;
  /** Reused verbatim from the Workspace seam: writeFile/readFile/list, id-bound. */
  fs: SandboxFsAccess;
  /**
   * Run a command inside the sandbox (argv form), streaming output. Same shape as
   * {@link import("./sandbox-client.js").SandboxClient.exec} with the id bound —
   * lets an adapter shell out (e.g. a future `git clone` or `tar -x`) rather than
   * write file-by-file.
   */
  exec(
    command: string[],
    opts?: SandboxExecOptions,
  ): AsyncIterable<SandboxExecChunk>;
}

/**
 * The **critical invariant** (design doc §1 note, ADR-0005 §3, deletion test §7):
 * a projection's `targetPath` MUST lie *outside* the Workspace's `workspaceDir`.
 * If it were inside, the next Workspace sync's full recursive scan of
 * `workspaceDir` would pick the projected content up, treat it as a user artifact,
 * and write it back — polluting the Workspace (and, on the next hydrate, deleting
 * or duplicating it). Keeping projections outside `workspaceDir` is exactly why
 * that scan never sees them (see the "never synced" test).
 *
 * The check belongs to the SandboxManager (#77), which is the layer that knows
 * `workspaceDir`; #76 provides this reusable predicate/assert pair so #77 can call
 * it and **fail loud** rather than silently corrupt a Workspace.
 *
 * "Outside" means `targetPath` is neither equal to `workspaceDir` nor nested under
 * it. Paths are normalized (trailing slashes stripped) before comparison so
 * `/workspace` and `/workspace/` are treated the same, and `/workspaceX` is *not*
 * considered inside `/workspace`.
 */
export function isInsideWorkspace(
  targetPath: string,
  workspaceDir: string,
): boolean {
  const target = stripTrailingSlashes(targetPath);
  const ws = stripTrailingSlashes(workspaceDir);
  return target === ws || target.startsWith(`${ws}/`);
}

/**
 * Fail-loud guard for the containment invariant above: throws if `targetPath` is
 * inside `workspaceDir`, otherwise returns. The SandboxManager (#77) calls this on
 * every projection in an EnvSpec before creating the sandbox, so a mis-declared
 * projection is rejected up front — never allowed to pollute the Workspace.
 */
export function assertProjectionOutsideWorkspace(
  targetPath: string,
  workspaceDir: string,
): void {
  if (isInsideWorkspace(targetPath, workspaceDir)) {
    throw new Error(
      `Read-only projection targetPath "${targetPath}" is inside the workspace ` +
        `"${workspaceDir}"; projections MUST lie outside the workspace or the ` +
        `next sync would write them back (design doc §1, ADR-0005 §3).`,
    );
  }
}

function stripTrailingSlashes(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

// ─── S3 adapter ─────────────────────────────────────────────────────────────

/**
 * The S3 coordinate shape for `kind: "s3"`.
 *
 * A Skill's files live in a distinct S3 namespace keyed by
 * `<tenantId>/skills/<skillId>/<path>` and are addressed through
 * {@link SkillArtifactStore} by the `(tenantId, skillId)` pair — the store owns
 * the prefix; callers never see the key layout (see
 * `store/src/s3/skill-artifact-store.ts`). So the coordinate carries exactly
 * `{ tenantId, skillId }`: the pair that maps cleanly onto
 * `SkillArtifactStore.getAll(tenantId, skillId)`. We deliberately do *not* pass a
 * raw `prefix` — that would leak the store's private key layout into the Host and
 * duplicate the isolation logic the store already owns.
 */
export interface S3ProvisionRef {
  tenantId: string;
  skillId: string;
}

/**
 * Today's only {@link ProvisionSource}: reads a Skill's files from S3 (the
 * {@link SkillArtifactStore}) and writes them into the sandbox under
 * `target.targetPath`. Content flows S3 → sandbox directly; the Host supplied only
 * the `{ tenantId, skillId }` coordinate (design doc §5, ADR-0005 §3).
 *
 * Registered under `kind: "s3"` in the SandboxManager's `provisionSources` map.
 */
export class S3ProvisionSource implements ProvisionSource {
  constructor(private readonly skills: SkillArtifactStore) {}

  async project(
    coord: ProvisionCoordinate,
    target: ProjectionTarget,
  ): Promise<void> {
    const { tenantId, skillId } = parseS3Ref(coord.ref);
    // getAll reads every file of the Skill (path + bytes); the store owns the
    // `<tenant>/skills/<skill>/…` prefix, so we never touch the key layout.
    const files = await this.skills.getAll(tenantId, skillId);
    for (const file of files) {
      await target.fs.writeFileBytes(
        joinPath(target.targetPath, file.path),
        file.body,
      );
    }
  }
}

/** Read + validate the `{ tenantId, skillId }` pair out of a weak-typed ref. */
function parseS3Ref(ref: Record<string, string>): S3ProvisionRef {
  const { tenantId, skillId } = ref;
  if (!tenantId || !skillId) {
    throw new Error(
      `s3 provision ref requires { tenantId, skillId }; got ${JSON.stringify(ref)}`,
    );
  }
  return { tenantId, skillId };
}

/** Join an absolute sandbox base with a projection-relative path (no `..`). */
function joinPath(base: string, rel: string): string {
  const cleanBase = stripTrailingSlashes(base);
  const cleanRel = rel.replace(/^\.\//, "").replace(/^\/+/, "");
  const segments = cleanRel.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) {
    throw new Error(`projection path escapes target: ${rel}`);
  }
  return segments.length ? `${cleanBase}/${segments.join("/")}` : cleanBase;
}

// ─── Fake adapter (tests) ─────────────────────────────────────────────────────

/**
 * In-memory {@link ProvisionSource} for tests, so a test can exercise the seam and
 * the projection mechanism without touching real S3. Canned files are seeded per
 * coordinate `kind`+`ref` and written into the fake sandbox at `targetPath` on
 * `project`, giving the same observable contract as {@link S3ProvisionSource}.
 *
 * The default `kind` is `"fake"`, but a test can register the instance under any
 * `kind` (e.g. `"s3"`) in a `Record<string, ProvisionSource>` dispatch map to
 * prove kind-based dispatch.
 */
export class FakeProvisionSource implements ProvisionSource {
  /** Canned files keyed by a stable coordinate key → { relPath → content }. */
  private readonly canned = new Map<string, Map<string, string>>();
  /** Coordinates seen by `project`, in order (test helper for dispatch asserts). */
  readonly projected: ProvisionCoordinate[] = [];

  /**
   * Seed the canned files a given coordinate resolves to. `ref` is matched
   * exactly (same keys+values), so a test seeds `{ kind, ref }` and later projects
   * with the same coordinate.
   */
  seed(
    coord: ProvisionCoordinate,
    files: Record<string, string>,
  ): void {
    this.canned.set(coordKey(coord), new Map(Object.entries(files)));
  }

  async project(
    coord: ProvisionCoordinate,
    target: ProjectionTarget,
  ): Promise<void> {
    this.projected.push(coord);
    const files = this.canned.get(coordKey(coord)) ?? new Map();
    for (const [rel, content] of files) {
      await target.fs.writeFile(joinPath(target.targetPath, rel), content);
    }
  }
}

/** Stable key for a coordinate: `kind` + its sorted ref entries. */
function coordKey(coord: ProvisionCoordinate): string {
  const entries = Object.entries(coord.ref).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `${coord.kind}::${JSON.stringify(entries)}`;
}
