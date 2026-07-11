import type { ArtifactStore } from "@oma-server/store";
import { contentHash, type WorkspaceSyncResult } from "./workspace-sync.js";

/**
 * The size+mtime pre-filter's soundness rests on ONE invariant: **a write MUST
 * advance the file's mtime**. Given that, a file whose recorded size AND mtime
 * both still match cannot have changed, so skipping its read+hash is certain to
 * be safe. The pre-filter never *decides* a file changed — a size/mtime delta
 * only forces a hash, and the content hash stays the final arbiter of change
 * (ADR-0005 §4 / ADR-0002 §4). Its only job is to save work when nothing moved.
 *
 * Where the invariant holds:
 *  - The fake ({@link FakeSandboxClient}) stamps a strictly-monotonic mtime on
 *    every write (never on a read/list), so two writes are never confusable and
 *    a same-size edit always shows a fresher mtime.
 *  - Real POSIX filesystems advance mtime on every write, so the invariant holds
 *    in principle in production too.
 *
 * In production the e2b backend reads mtime via `find -printf '%T@'`
 * ({@link import("./e2b-sandbox-client.js").parseFindOutput}). `%T@` is a
 * *fractional* epoch second — GNU find emits sub-second precision (nanosecond
 * on modern filesystems), and we keep it as `Math.round(sec * 1000)` ms — so a
 * same-size edit within the same wall-clock second still shows a fresher mtime
 * and is not skipped. The invariant therefore holds on any filesystem whose
 * mtime granularity is finer than a turn's think time (i.e. all modern ones).
 *
 * The residual edge is the standard POSIX one: a filesystem with coarse (e.g.
 * whole-second) mtime granularity *could* report an identical mtime for a
 * same-size edit made within one granularity tick. This is why the content hash
 * — not the pre-filter — is the arbiter: the pre-filter is a pure optimization
 * layered on top, and if a backend's mtime is ever proven too coarse to satisfy
 * the write-advances-mtime invariant, the safe response is to make this
 * pre-filter more conservative (skip only when certain) rather than to trust it
 * as the sole signal. See {@link canSkipHash}.
 */
function canSkipHash(
  prior: S3PathState | undefined,
  entry: SandboxFsEntry,
): boolean {
  // Skip the read+hash ONLY when we are certain the file is unchanged: both size
  // and mtime match the values recorded when we last saw (hydrated/synced) it.
  // Any delta ⇒ we must read and hash. This is sound exactly because a write
  // advances mtime (see the module note above).
  return (
    prior != null && prior.size === entry.size && prior.mtimeMs === entry.mtimeMs
  );
}

/**
 * The medium-agnostic home of a Workspace's persistent state (CONTEXT.md
 * "Workspace Store"; ADR-0005 §2; design doc §5). Owns the **two-way**
 * hydrate/sync of the sandbox's writable workspace area:
 *
 *  - `hydrate` restores the Workspace's persisted state into a fresh sandbox and
 *    hands back an opaque {@link HydrationSession} (the medium's private memory
 *    of "the world as I saw it on entry" — e.g. the S3 baseline + content
 *    hashes; another medium may hold something else, or nothing at all).
 *  - `sync` uses that same session to write the sandbox's current workspace
 *    state back, and decides for itself what "changed" and "deleted" mean.
 *
 * The one thing sealed behind this seam is the storage **medium**. S3 is today's
 * only implementation ({@link S3WorkspacePersistence}); a persistent volume, an
 * image snapshot, or an in-sandbox sidecar would each be another. Callers (and
 * the future SandboxManager) never learn which medium is in play — in
 * particular they never see the {@link Baseline}, which is private to the
 * adapter and carried only inside the opaque session.
 */
export interface WorkspacePersistence {
  /**
   * Hydrate the workspace area into the sandbox; returns an opaque session
   * (holding the baseline or the medium's equivalent) to be threaded into the
   * matching {@link sync}.
   */
  hydrate(target: HydrateTarget): Promise<HydrationSession>;

  /**
   * Using the same session, sync the sandbox's current workspace state back.
   * The medium decides what "changed/deleted" means.
   */
  sync(session: HydrationSession, target: HydrateTarget): Promise<SyncResult>;
}

/**
 * The result of one workspace sync-back. Reused, verbatim, from the sync slice
 * (#43): the canonical type stays {@link WorkspaceSyncResult} because the Router
 * and existing tests reference it; {@link SyncResult} is the design-doc §4 alias.
 */
export type SyncResult = WorkspaceSyncResult;

/**
 * The minimal sandbox read/write capability a {@link WorkspacePersistence}
 * needs, with the backend sandbox `id` already bound by the caller. It is the
 * same three ops as {@link import("./sandbox-client.js").SandboxClient} —
 * `writeFile`/`readFile`/`list` — but id-free, so the persistence layer never
 * learns which backend (e2b, a fake, …) it is talking to. The caller supplies a
 * thin closure over the current live sandbox.
 */
export interface SandboxFsAccess {
  /** Write a UTF-8 file at an absolute sandbox path, creating parents. */
  writeFile(path: string, content: string): Promise<void>;
  /** Read a UTF-8 file at an absolute sandbox path. */
  readFile(path: string): Promise<string>;
  /** Write exact bytes at an absolute sandbox path, creating parents. */
  writeFileBytes(path: string, content: Uint8Array): Promise<void>;
  /** Read exact bytes at an absolute sandbox path. */
  readFileBytes(path: string): Promise<Uint8Array>;
  /** List files under an absolute sandbox directory (recursively). */
  list(dir: string): Promise<SandboxFsEntry[]>;
}

/**
 * A file entry from {@link SandboxFsAccess.list}. Mirrors the sandbox client's
 * entry: an absolute path plus the `size`/`mtimeMs` the sync pre-filter relies
 * on to skip re-hashing untouched files.
 */
export interface SandboxFsEntry {
  /** Absolute path inside the sandbox. */
  path: string;
  size: number;
  mtimeMs: number;
}

/**
 * What the persistence layer is given for one hydrate/sync: which Workspace,
 * where it lives inside the sandbox, and the id-bound filesystem access over the
 * current live sandbox.
 */
export interface HydrateTarget {
  tenantId: string;
  workspaceId: string;
  /** Absolute sandbox dir the Workspace hydrates into (e.g. `/workspace`). */
  workspaceDir: string;
  /** Filled by the caller with the current live sandbox: writeFile/readFile/list. */
  fs: SandboxFsAccess;
}

/**
 * Opaque handle threaded from `hydrate` into the matching `sync`. Neither the
 * caller nor the future SandboxManager reads its internals — the medium
 * downcasts it privately. The branded shape makes the interface honest: swapping
 * S3 for a medium that keeps no baseline changes nothing here.
 */
export type HydrationSession = { readonly __brand: "hydration-session" };

// ─── S3 adapter ─────────────────────────────────────────────────────────────

/**
 * Per-path state the S3 adapter records at hydrate time and consults on sync.
 * `hash` is the content-hash the sync compares against (the final arbiter of
 * change); `size`/`mtimeMs` drive the pre-filter that lets an untouched file
 * skip the read+hash entirely.
 */
interface S3PathState {
  hash: string;
  size: number;
  mtimeMs: number;
}

/**
 * The S3 adapter's private session shape, hidden behind {@link HydrationSession}.
 *
 *  - `baseline` is the {@link Baseline}: the workspace-relative paths seen on
 *    hydrate. Sync deletes from S3 only baseline paths that have since gone
 *    missing, so a concurrent Session's newly added files are never deleted.
 *  - `state` is the content-hash (+ size/mtime pre-filter) comparison map,
 *    keyed by workspace-relative path.
 *
 * Both live inside the opaque session so no caller can read them.
 */
interface S3HydrationSession {
  baseline: string[];
  state: Map<string, S3PathState>;
}

/** Downcast the opaque handle back to the S3 adapter's private shape. */
function asS3Session(session: HydrationSession): S3HydrationSession {
  // The handle only ever originates from this adapter's own `hydrate`, so the
  // cast is sound; the brand keeps other code from constructing/reading it.
  return session as unknown as S3HydrationSession;
}

/**
 * Today's only {@link WorkspacePersistence}: S3 (the {@link ArtifactStore}) is
 * the authoritative medium. The baseline and content-hash state live inside the
 * opaque {@link HydrationSession} rather than on the caller, and sync applies a
 * size+mtime pre-filter before hashing.
 */
export class S3WorkspacePersistence implements WorkspacePersistence {
  constructor(private readonly artifactStore: ArtifactStore) {}

  /**
   * List the Workspace's S3 artifacts, write each into the sandbox `/workspace`,
   * capture the workspace-relative paths as the {@link Baseline}, and seed the
   * content-hash (+ size/mtime) comparison state — all inside the returned
   * opaque session.
   */
  async hydrate(target: HydrateTarget): Promise<HydrationSession> {
    const { tenantId, workspaceId, workspaceDir, fs } = target;
    const artifacts = await this.artifactStore.list(tenantId, workspaceId);
    const baseline: string[] = [];
    const hashes = new Map<string, string>();
    for (const artifact of artifacts) {
      const content = await this.artifactStore.get(
        tenantId,
        workspaceId,
        artifact.path,
      );
      if (!content) continue;
      await fs.writeFileBytes(resolve(workspaceDir, artifact.path), content.body);
      const rel = normalizeRel(artifact.path);
      baseline.push(rel);
      hashes.set(rel, contentHash(content.body));
    }
    baseline.sort();
    const session: S3HydrationSession = {
      baseline,
      // Seed size+mtime from the sandbox's own view of the files we just wrote
      // (a single post-write scan), so the next sync's pre-filter has a truthful
      // starting point — the mtime is the sandbox's, not S3's.
      state: await seedState(workspaceDir, fs, hashes),
    };
    return session as unknown as HydrationSession;
  }

  /**
   * Sync the sandbox `/workspace` back to S3. Steps (unchanged from the executor
   * except the pre-filter):
   *
   *  1. **Full scan** — list every file under `workspaceDir` (recursive), so
   *     files created by any means (bash, a write tool, a compiler) are caught.
   *  2. **Size+mtime pre-filter → content-hash push** — a file whose recorded
   *     size AND mtime are unchanged skips the read entirely; otherwise we read
   *     and hash, and push to S3 only when the content hash is new or differs.
   *     Content hash stays the final arbiter (a same-size same-mtime edit is
   *     astronomically unlikely, but any size/mtime delta forces a hash to
   *     confirm). The per-path size/mtime is re-recorded for the next sync.
   *  3. **Baseline-diff deletion** — delete from S3 only paths in this session's
   *     baseline that are now absent from the scan; a concurrent Session's added
   *     files are never in this baseline, so they are never deleted.
   */
  async sync(
    session: HydrationSession,
    target: HydrateTarget,
  ): Promise<SyncResult> {
    const { tenantId, workspaceId, workspaceDir, fs } = target;
    const { baseline, state } = asS3Session(session);

    // 1. Full recursive scan of the workspace dir → workspace-relative paths.
    const entries = await fs.list(workspaceDir);
    const present = new Set<string>();
    const changed: string[] = [];

    // 2. Size+mtime pre-filter, then content-hash push for anything that moved.
    for (const entry of entries) {
      const rel = toRelative(workspaceDir, entry.path);
      if (rel === "") continue;
      present.add(rel);
      const prior = state.get(rel);
      // Pre-filter: skip read+hash only when certain the file is unchanged.
      if (canSkipHash(prior, entry)) continue;
      const bytes = await fs.readFileBytes(entry.path);
      const hash = contentHash(bytes);
      // Content hash is the final arbiter: a size/mtime delta on a byte-identical
      // file (rare, but possible) still short-circuits here without a push.
      if (prior?.hash === hash) {
        // Re-record the fresh size/mtime so the next sync's pre-filter matches.
        state.set(rel, { hash, size: entry.size, mtimeMs: entry.mtimeMs });
        continue;
      }
      await this.artifactStore.put({
        tenantId,
        workspaceId,
        path: rel,
        body: bytes,
        contentType: contentTypeForPath(rel),
      });
      state.set(rel, { hash, size: entry.size, mtimeMs: entry.mtimeMs });
      changed.push(rel);
    }

    // 3. Baseline-diff deletion — only hydrated paths now missing.
    const deleted: string[] = [];
    for (const rel of baseline) {
      if (present.has(rel)) continue;
      const existed = await this.artifactStore.delete(
        tenantId,
        workspaceId,
        rel,
      );
      state.delete(rel);
      if (existed) deleted.push(rel);
    }

    changed.sort();
    deleted.sort();
    return { tenantId, workspaceId, changed, deleted };
  }
}

// ─── Fake adapter (tests) ────────────────────────────────────────────────────

/**
 * In-memory {@link WorkspacePersistence} for tests, so a test can exercise the
 * seam without touching real S3. An internal map plays the role of the medium's
 * persistent store; hydrate seeds the sandbox and baseline from it, sync writes
 * changed files back and applies baseline-diff deletes — the same observable
 * contract as {@link S3WorkspacePersistence}, including the size+mtime
 * pre-filter (so tests can prove an untouched file is never re-read/hashed).
 *
 * The store is keyed by `${tenantId}/${workspaceId}/${path}` so multiple
 * Workspaces (and multiple sessions sharing one Workspace) can coexist.
 */
export class FakeWorkspacePersistence implements WorkspacePersistence {
  private readonly store = new Map<string, Uint8Array>();

  private key(tenantId: string, workspaceId: string, path: string): string {
    return `${tenantId}/${workspaceId}/${path}`;
  }

  /** Seed the medium's persistent store with a workspace-relative file. */
  seed(
    tenantId: string,
    workspaceId: string,
    path: string,
    content: string | Uint8Array,
  ): void {
    const bytes =
      typeof content === "string"
        ? new TextEncoder().encode(content)
        : new Uint8Array(content);
    this.store.set(this.key(tenantId, workspaceId, normalizeRel(path)), bytes);
  }

  /** Current stored content for a workspace-relative path (test helper). */
  contentOf(
    tenantId: string,
    workspaceId: string,
    path: string,
  ): string | undefined {
    const bytes = this.store.get(
      this.key(tenantId, workspaceId, normalizeRel(path)),
    );
    return bytes ? new TextDecoder().decode(bytes) : undefined;
  }

  /** Exact stored bytes for binary-safety assertions. */
  bytesOf(
    tenantId: string,
    workspaceId: string,
    path: string,
  ): Uint8Array | undefined {
    const bytes = this.store.get(
      this.key(tenantId, workspaceId, normalizeRel(path)),
    );
    return bytes ? new Uint8Array(bytes) : undefined;
  }

  /** Workspace-relative paths currently in the store, sorted (test helper). */
  pathsOf(tenantId: string, workspaceId: string): string[] {
    const prefix = `${tenantId}/${workspaceId}/`;
    const out: string[] = [];
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) out.push(k.slice(prefix.length));
    }
    return out.sort();
  }

  async hydrate(target: HydrateTarget): Promise<HydrationSession> {
    const { tenantId, workspaceId, workspaceDir, fs } = target;
    const prefix = `${tenantId}/${workspaceId}/`;
    const baseline: string[] = [];
    const hashes = new Map<string, string>();
    for (const [k, bytes] of this.store) {
      if (!k.startsWith(prefix)) continue;
      const rel = k.slice(prefix.length);
      await fs.writeFileBytes(resolve(workspaceDir, rel), bytes);
      baseline.push(rel);
      hashes.set(rel, contentHash(bytes));
    }
    baseline.sort();
    const session: S3HydrationSession = {
      baseline,
      state: await seedState(workspaceDir, fs, hashes),
    };
    return session as unknown as HydrationSession;
  }

  async sync(
    session: HydrationSession,
    target: HydrateTarget,
  ): Promise<SyncResult> {
    const { tenantId, workspaceId, workspaceDir, fs } = target;
    const { baseline, state } = asS3Session(session);

    const entries = await fs.list(workspaceDir);
    const present = new Set<string>();
    const changed: string[] = [];

    for (const entry of entries) {
      const rel = toRelative(workspaceDir, entry.path);
      if (rel === "") continue;
      present.add(rel);
      const prior = state.get(rel);
      if (canSkipHash(prior, entry)) continue; // pre-filter: certainly unchanged.
      const bytes = await fs.readFileBytes(entry.path);
      const hash = contentHash(bytes);
      if (prior?.hash === hash) {
        state.set(rel, { hash, size: entry.size, mtimeMs: entry.mtimeMs });
        continue;
      }
      this.store.set(this.key(tenantId, workspaceId, rel), new Uint8Array(bytes));
      state.set(rel, { hash, size: entry.size, mtimeMs: entry.mtimeMs });
      changed.push(rel);
    }

    const deleted: string[] = [];
    for (const rel of baseline) {
      if (present.has(rel)) continue;
      const existed = this.store.delete(this.key(tenantId, workspaceId, rel));
      state.delete(rel);
      if (existed) deleted.push(rel);
    }

    changed.sort();
    deleted.sort();
    return { tenantId, workspaceId, changed, deleted };
  }
}

// ─── path helpers (mirrors the executor's own) ───────────────────────────────

/**
 * Combine per-path content hashes (from what we just hydrated) with the
 * sandbox's own size+mtime for those paths (a single post-write scan of
 * `workspaceDir`) into the sync comparison state. Seeding size/mtime from the
 * live sandbox — not S3 — is what lets the next sync's pre-filter recognize an
 * untouched file and skip re-reading it.
 */
async function seedState(
  workspaceDir: string,
  fs: SandboxFsAccess,
  hashes: Map<string, string>,
): Promise<Map<string, S3PathState>> {
  const state = new Map<string, S3PathState>();
  const entries = await fs.list(workspaceDir);
  const byRel = new Map(entries.map((e) => [toRelative(workspaceDir, e.path), e]));
  for (const [rel, hash] of hashes) {
    const entry = byRel.get(rel);
    state.set(rel, {
      hash,
      size: entry?.size ?? 0,
      mtimeMs: entry?.mtimeMs ?? 0,
    });
  }
  return state;
}

/** Resolve a workspace-relative path to an absolute sandbox path. */
function resolve(workspaceDir: string, rel: string): string {
  const clean = normalizeRel(rel);
  return clean ? `${workspaceDir}/${clean}` : workspaceDir;
}

/** Turn an absolute sandbox path back into a workspace-relative path. */
function toRelative(workspaceDir: string, abs: string): string {
  const prefix = `${workspaceDir}/`;
  if (abs === workspaceDir) return "";
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : abs;
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

/** MIME for files produced inside the sandbox (whose filesystem has no MIME). */
function contentTypeForPath(path: string): string | undefined {
  const extension = path.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "avif":
      return "image/avif";
    case "bmp":
      return "image/bmp";
    case "ico":
      return "image/x-icon";
    case "svg":
      return "image/svg+xml";
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
    case "mkv":
      return "video/x-matroska";
    case "ogv":
      return "video/ogg";
    default:
      return undefined;
  }
}
