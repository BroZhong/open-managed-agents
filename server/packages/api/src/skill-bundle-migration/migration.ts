import { parseArgs } from "node:util";
import {
  InvalidSkillFileError,
  SkillBundleTooLargeError,
  assertSkillBundleIdentity,
  isFilteredSkillPath,
  isSkillBundleSha256,
  packSkillBundle,
  unpackSkillBundle,
  type PackedSkillBundle,
  type Pool,
  type SkillBundleFile,
  type SkillBundleStore,
  type SkillOwnerType,
} from "@oma-server/store";
import { MigrationError, safeErrorMessage } from "./errors.js";
import { fontProblem, isFontPath, isReplacementFontPath, repairFonts, sha256Hex, type CorruptFont, type FontReplacement, type ReplacementFont } from "./fonts.js";
import { Semaphore, type SupabaseReadStats } from "./supabase-reader.js";

/**
 * The one-time Skill Bundle migration (#266, ADR-0022): for each Skill row,
 * read its files from Supabase Storage, repair the corrupted
 * LiberationSans-Regular.ttf, pack a Skill Bundle (dropping `.pyc` and
 * `__pycache__`), upload it, read it back, and record `bundle_sha256` and
 * `bundle_size` by compare-and-set on `bundle_sha256` with direct SQL that
 * leaves `updated_at` alone.
 *
 * Ownership rule: a row is rewritten only when its bundle is NULL or is still
 * the bundle a previous run of this tool recorded (the `--manifest` reports).
 * Any other bundle was published by someone else (the new API) and is kept
 * without reading Supabase. A rerun therefore converges: bundles are
 * content-addressed and deterministic, so an unchanged Skill repacks to its
 * current bundle and nothing is written.
 */

export type SkillStatus = "written" | "would-write" | "unchanged" | "kept" | "conflict" | "failed";

export interface SkillRow {
  tenantId: string;
  skillId: string;
  name: string;
  ownerType: SkillOwnerType;
  sourceSkillId: string | null;
  updatedAt: Date;
  /** Null when the row has no bundle, or the schema predates migration 0022. */
  bundleSha256: string | null;
}

export interface SkillRowStore {
  hasBundleColumns(): Promise<boolean>;
  /** Every Skill or, with `updatedAfter`, those updated after it or without a bundle; ordered by tenant and id. */
  list(updatedAfter?: Date): Promise<SkillRow[]>;
  /** Compare-and-set on `bundle_sha256`; false when the row no longer holds `expected`. */
  setBundle(row: Pick<SkillRow, "tenantId" | "skillId">, expected: string | null, bundle: { sha256: string; size: number }): Promise<boolean>;
}

export interface SkillFileSource {
  list(tenantId: string, skillId: string): Promise<string[]>;
  read(tenantId: string, skillId: string, path: string): Promise<Uint8Array>;
  readonly stats: SupabaseReadStats;
}

export interface MigrationTarget {
  /** PostgreSQL schema of the `skills` table. */
  schema: string;
  /** Supabase Storage bucket the Skill files are read from. */
  supabaseBucket: string;
  /** OSS bucket the bundles are written to. */
  ossBucket: string;
}

export interface Manifest {
  mode: "full" | "delta";
  startedAt: Date;
  /** `<tenantId>/<skillId>` → the bundle this tool recorded for the row. */
  bundles: Map<string, string>;
}

/**
 * A delta also selects Skills updated up to this long before `--since`. The
 * old API bumps `updated_at` before it writes Supabase, and Pod clocks skew,
 * so an edit straddling T0 can carry an `updated_at` a little before T0 while
 * the full run read the old files. A Skill selected needlessly repacks to its
 * current bundle and is `unchanged`.
 */
export const DELTA_MARGIN_MS = 10 * 60 * 1000;

export interface MigrationRunOptions {
  dryRun: boolean;
  /**
   * Delta: only Skills with `updated_at > since - DELTA_MARGIN_MS`, plus every
   * Skill without a bundle. Needs a full run's report as a manifest, and must
   * not be later than the earliest full run's `startedAt` among them.
   */
  since?: Date;
  /** Reports of previous non-dry runs, oldest first; later entries win. */
  manifests?: Manifest[];
  font: ReplacementFont;
  target: MigrationTarget;
  /** Skills processed at once; Supabase requests are bounded by the reader. Default 4. */
  skillConcurrency?: number;
  now?: () => Date;
  /** Progress lines: ids, statuses and digests only. */
  log?: (line: string) => void;
}

export interface MigrationDeps {
  rows: SkillRowStore;
  source: SkillFileSource;
  /** Must not serve reads from a cache, so the read-back is a real read. */
  bundles: Pick<SkillBundleStore, "put" | "get">;
}

export interface SkillReportEntry {
  tenantId: string;
  skillId: string;
  name: string;
  ownerType: SkillOwnerType;
  sourceSkillId: string | null;
  updatedAt: string;
  status: SkillStatus;
  reason?: string;
  /** `bundle_sha256` when the row was selected. */
  previousBundleSha256: string | null;
  /** Supabase objects listed and bytes read. */
  objects?: number;
  bytes?: number;
  /** The packed bundle. */
  bundleSha256?: string;
  bundleSize?: number;
  bundleFiles?: number;
  zipBytes?: number;
  filtered?: string[];
  replacedFonts?: FontReplacement[];
  /** Corrupt fonts other than the replacement font, published as stored. */
  corruptFonts?: CorruptFont[];
  /** What was published although it is not right, e.g. those fonts. Never fails the run. */
  warnings?: string[];
}

/** A font file of a verified bundle, as unpacked from it. */
export interface VerifiedFont {
  tenantId: string;
  bundleSha256: string;
  path: string;
  sha256: string;
  size: number;
  /** The first four bytes in hex: `00010000` for TrueType. */
  header: string;
  /** Why the file is not a valid font; null when it is. */
  problem: string | null;
}

export interface MigrationReport {
  tool: "migrate-skill-bundles";
  version: 1;
  mode: "full" | "delta";
  dryRun: boolean;
  /** The operator's T0; null for a full run. */
  since: string | null;
  /** {@link DELTA_MARGIN_MS} for a delta. */
  deltaMarginMs: number | null;
  /** `since - deltaMarginMs`: the delta selected `updated_at >` this, or no bundle. */
  selectedUpdatedAfter: string | null;
  target: MigrationTarget;
  manifests: Array<{ mode: string; startedAt: string; bundles: number }>;
  font: { fileName: string; sha256: string };
  startedAt: string;
  finishedAt: string;
  totals: {
    skills: number;
    byStatus: Partial<Record<SkillStatus, number>>;
    supabaseObjects: number;
    supabaseBytes: number;
    packedFiles: number;
    filteredFiles: number;
    replacedFonts: number;
    corruptFonts: number;
    warnings: number;
    distinctBundles: number;
    bundlesUploaded: number;
    uploadedZipBytes: number;
  };
  /** Bundles referenced by more than one Skill of this run, e.g. a Library Skill and its unedited forks. */
  sharedBundles: Array<{ tenantId: string; sha256: string; skillIds: string[] }>;
  /** Agent Skills compared with their Library source in this run. */
  forks: { total: number; sameBundleAsSource: string[]; differentFromSource: string[]; sourceNotPacked: string[] };
  /** Every distinct bundle unpacked again: from the bundle store on a real run, from memory on a dry run. */
  verification: {
    source: "bundle-store" | "packed";
    bundles: number;
    problems: Array<{ tenantId: string; sha256: string; problem: string }>;
    /** Every font file of every verified bundle. */
    fonts: VerifiedFont[];
  };
  supabase: SupabaseReadStats;
  skills: SkillReportEntry[];
}

const TOOL = "migrate-skill-bundles";
/** Any valid digest: lets the store's own identity validation judge a tenant id before anything is read. */
const PROBE_SHA256 = "0".repeat(64);
const MAX_REASON = 300;

const rowKey = (tenantId: string, skillId: string) => `${tenantId}/${skillId}`;
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A Skill the tool cannot migrate; the run goes on. */
class SkillFailure extends MigrationError {}

/** The tool's own message in full; any other error as name, code and HTTP status (see `errors.ts`). */
const reasonOf = (error: unknown) => safeErrorMessage(error).replace(/\s+/g, " ").slice(0, MAX_REASON);

/** The store's packing errors name a path or a size, never a URL: keep their message. */
function packFailure(error: unknown): never {
  if (error instanceof SkillBundleTooLargeError || error instanceof InvalidSkillFileError) throw new SkillFailure(error.message);
  throw error;
}

function memo<T>(cache: Map<string, Promise<T>>, key: string, create: () => Promise<T>): Promise<T> {
  let promise = cache.get(key);
  if (!promise) {
    promise = create();
    cache.set(key, promise);
  }
  return promise;
}

/**
 * What must hold for every migrated bundle. Another corrupt font is no
 * problem: it was published as stored, with a warning.
 */
function bundleProblems(files: readonly SkillBundleFile[], font: ReplacementFont): string[] {
  const problems: string[] = [];
  if (!files.some((file) => file.path === "SKILL.md")) problems.push("no SKILL.md");
  for (const file of files) {
    if (isFilteredSkillPath(file.path)) problems.push(`compiled Python present: ${file.path}`);
    if (isFontPath(file.path) && isReplacementFontPath(file.path, font)) {
      const problem = fontProblem(file.body);
      if (problem) problems.push(`invalid font ${file.path}: ${problem}`);
    }
  }
  return problems;
}

/** Direct SQL on the `skills` table of the pool's search_path schema. Never touches `updated_at`. */
export class PgSkillRows implements SkillRowStore {
  private columns?: Promise<boolean>;

  constructor(private readonly pool: Pool) {}

  hasBundleColumns(): Promise<boolean> {
    this.columns ??= this.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'skills'`,
    ).then(({ rows }) => {
      const names = new Set(rows.map((row) => row.column_name));
      return names.has("bundle_sha256") && names.has("bundle_size");
    });
    return this.columns;
  }

  async list(updatedAfter?: Date): Promise<SkillRow[]> {
    const columns = await this.hasBundleColumns();
    // Before migration 0022 no Skill has a bundle, so a delta selects them all.
    const where = updatedAfter && columns ? "WHERE updated_at > $1 OR bundle_sha256 IS NULL" : "";
    const { rows } = await this.pool.query<{
      tenant_id: string; skill_id: string; name: string; owner_type: SkillOwnerType; source_skill_id: string | null;
      updated_at: Date; bundle_sha256: string | null;
    }>(
      `SELECT tenant_id, skill_id, name, owner_type, source_skill_id, updated_at, ${columns ? "bundle_sha256" : "NULL AS bundle_sha256"}
       FROM skills ${where} ORDER BY tenant_id, skill_id`,
      where ? [updatedAfter] : [],
    );
    return rows.map((row) => ({
      tenantId: row.tenant_id, skillId: row.skill_id, name: row.name, ownerType: row.owner_type,
      sourceSkillId: row.source_skill_id ?? null, updatedAt: new Date(row.updated_at), bundleSha256: row.bundle_sha256 ?? null,
    }));
  }

  async setBundle(row: Pick<SkillRow, "tenantId" | "skillId">, expected: string | null, bundle: { sha256: string; size: number }): Promise<boolean> {
    const params: unknown[] = [bundle.sha256, bundle.size, row.tenantId, row.skillId];
    let guard = "bundle_sha256 IS NULL";
    if (expected !== null) {
      params.push(expected);
      guard = "bundle_sha256 = $5";
    }
    const { rowCount } = await this.pool.query(
      `UPDATE skills SET bundle_sha256 = $1, bundle_size = $2 WHERE tenant_id = $3 AND skill_id = $4 AND ${guard}`, params);
    return rowCount === 1;
  }
}

/** A previous non-dry run's report of the same environment, as the set of rows this tool owns. */
export function parseManifest(json: unknown, target: MigrationTarget): Manifest {
  const report = json as Partial<MigrationReport> | null;
  if (!report || typeof report !== "object" || report.tool !== TOOL || report.version !== 1 || !Array.isArray(report.skills)) {
    throw new MigrationError(`The manifest is not a ${TOOL} report`);
  }
  if (report.dryRun !== false) throw new MigrationError("A dry-run report cannot be a manifest: it recorded no bundle");
  for (const field of ["schema", "supabaseBucket", "ossBucket"] as const) {
    if (report.target?.[field] !== target[field]) {
      throw new MigrationError(`The manifest is for ${field} ${JSON.stringify(report.target?.[field])}, not ${JSON.stringify(target[field])}`);
    }
  }
  const startedAt = new Date(String(report.startedAt));
  if (Number.isNaN(startedAt.getTime()) || (report.mode !== "full" && report.mode !== "delta")) throw new MigrationError(`The manifest is not a ${TOOL} report`);
  const bundles = new Map<string, string>();
  for (const skill of report.skills) {
    if ((skill.status === "written" || skill.status === "unchanged") && isSkillBundleSha256(skill.bundleSha256)) {
      bundles.set(rowKey(skill.tenantId, skill.skillId), skill.bundleSha256);
    }
  }
  return { mode: report.mode, startedAt, bundles };
}

export async function migrateSkillBundles(deps: MigrationDeps, options: MigrationRunOptions): Promise<MigrationReport> {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const manifests = options.manifests ?? [];
  const startedAt = now();
  if (options.since) {
    const fulls = manifests.filter((manifest) => manifest.mode === "full");
    if (!fulls.length) throw new MigrationError("A delta (--since) needs the full run's report as --manifest");
    const earliest = new Date(Math.min(...fulls.map((manifest) => manifest.startedAt.getTime())));
    if (options.since > earliest) {
      throw new MigrationError(`--since ${options.since.toISOString()} is later than the earliest full run's start (${earliest.toISOString()}): ` +
        "Skills edited during that run would be missed");
    }
  }
  const selectedUpdatedAfter = options.since && new Date(options.since.getTime() - DELTA_MARGIN_MS);
  if (!options.dryRun && !(await deps.rows.hasBundleColumns())) {
    throw new MigrationError(`skills.bundle_sha256 / bundle_size are missing in schema ${options.target.schema}: apply deploy/migrations/0022_skill_bundles.sql first`);
  }
  const owned = new Map<string, string>();
  for (const manifest of manifests) for (const [key, sha256] of manifest.bundles) owned.set(key, sha256);

  const uploads = new Map<string, Promise<number>>();
  const verified = new Map<string, Promise<void>>();
  const problems: MigrationReport["verification"]["problems"] = [];
  const fonts: VerifiedFont[] = [];
  let verifiedBundles = 0;
  const verify = (tenantId: string, sha256: string, load: () => Promise<Uint8Array | null>) =>
    memo(verified, rowKey(tenantId, sha256), async () => {
      const bytes = await load();
      if (!bytes) throw new SkillFailure(`bundle ${sha256} is missing from the bundle store`);
      const files = await unpackSkillBundle(bytes);
      for (const problem of bundleProblems(files, options.font)) problems.push({ tenantId, sha256, problem });
      for (const file of files.filter((entry) => isFontPath(entry.path))) {
        fonts.push({
          tenantId, bundleSha256: sha256, path: file.path, sha256: sha256Hex(file.body), size: file.body.byteLength,
          header: Buffer.from(file.body.subarray(0, 4)).toString("hex"), problem: fontProblem(file.body),
        });
      }
      verifiedBundles += 1;
    });
  const upload = (tenantId: string, packed: PackedSkillBundle) =>
    memo(uploads, rowKey(tenantId, packed.sha256), async () => {
      await deps.bundles.put(tenantId, packed);
      return packed.bytes.byteLength;
    });

  const rows = await deps.rows.list(selectedUpdatedAfter);
  const slots = new Semaphore(options.skillConcurrency ?? 4);
  let done = 0;
  const skills = await Promise.all(rows.map((row) => slots.run(async () => {
    const entry: SkillReportEntry = {
      tenantId: row.tenantId, skillId: row.skillId, name: row.name, ownerType: row.ownerType, sourceSkillId: row.sourceSkillId,
      updatedAt: row.updatedAt.toISOString(), status: "failed", previousBundleSha256: row.bundleSha256,
    };
    const mine = owned.get(rowKey(row.tenantId, row.skillId));
    if (row.bundleSha256 !== null && row.bundleSha256 !== mine) {
      entry.status = "kept";
      entry.reason = mine === undefined
        ? "has a bundle not written by this migration (pass the previous report as --manifest to refresh it)"
        : "bundle changed since the manifest: published by another writer (the new API)";
    } else {
      try {
        try {
          assertSkillBundleIdentity(row.tenantId, PROBE_SHA256);
        } catch {
          throw new SkillFailure("tenant id is not a valid Skill Bundle key segment");
        }
        const paths = await deps.source.list(row.tenantId, row.skillId);
        entry.objects = paths.length;
        if (!paths.length) throw new SkillFailure("no Supabase objects");
        if (!paths.includes("SKILL.md")) throw new SkillFailure("no SKILL.md");
        const files = await Promise.all(paths.map(async (path) => ({ path, body: await deps.source.read(row.tenantId, row.skillId, path) })));
        entry.bytes = files.reduce((total, file) => total + file.body.byteLength, 0);
        const repaired = repairFonts(files, options.font);
        const packed = await packSkillBundle(repaired.files).catch(packFailure);
        Object.assign(entry, {
          bundleSha256: packed.sha256, bundleSize: packed.size, bundleFiles: packed.files, zipBytes: packed.bytes.byteLength,
          filtered: packed.filtered, replacedFonts: repaired.replaced, corruptFonts: repaired.corrupt,
        });
        if (repaired.corrupt.length) entry.warnings = repaired.corrupt.map((corrupt) => `corrupt font ${corrupt.path} kept as stored: ${corrupt.problem}`);
        const stored = () => deps.bundles.get(row.tenantId, packed.sha256);
        if (options.dryRun) {
          await verify(row.tenantId, packed.sha256, async () => packed.bytes);
          entry.status = packed.sha256 === row.bundleSha256 ? "unchanged" : "would-write";
        } else if (packed.sha256 === row.bundleSha256) {
          await verify(row.tenantId, packed.sha256, stored);
          entry.status = "unchanged";
        } else {
          await upload(row.tenantId, packed);
          await verify(row.tenantId, packed.sha256, stored);
          if (await deps.rows.setBundle(row, row.bundleSha256, packed)) {
            entry.status = "written";
          } else {
            entry.status = "conflict";
            entry.reason = "the row changed concurrently (another bundle was published or the Skill was deleted); rerun to re-evaluate";
          }
        }
      } catch (error) {
        entry.status = "failed";
        entry.reason = reasonOf(error);
      }
    }
    done += 1;
    log(`[${done}/${rows.length}] ${row.tenantId}/${row.skillId} ${entry.status}` +
      `${entry.bundleSha256 ? ` ${entry.bundleSha256.slice(0, 12)}` : ""}${entry.reason ? ` (${entry.reason})` : ""}`);
    return entry;
  })));

  const byStatus: Partial<Record<SkillStatus, number>> = {};
  for (const skill of skills) byStatus[skill.status] = (byStatus[skill.status] ?? 0) + 1;
  const sum = (pick: (skill: SkillReportEntry) => number | undefined) => skills.reduce((total, skill) => total + (pick(skill) ?? 0), 0);
  const groups = new Map<string, { tenantId: string; sha256: string; skillIds: string[] }>();
  for (const skill of skills) {
    if (!skill.bundleSha256) continue;
    const group = groups.get(rowKey(skill.tenantId, skill.bundleSha256)) ?? { tenantId: skill.tenantId, sha256: skill.bundleSha256, skillIds: [] };
    group.skillIds.push(skill.skillId);
    groups.set(rowKey(skill.tenantId, skill.bundleSha256), group);
  }
  const packedById = new Map(skills.filter((skill) => skill.bundleSha256).map((skill) => [rowKey(skill.tenantId, skill.skillId), skill.bundleSha256]));
  const forks: MigrationReport["forks"] = { total: 0, sameBundleAsSource: [], differentFromSource: [], sourceNotPacked: [] };
  for (const skill of skills) {
    if (skill.ownerType !== "agent" || !skill.sourceSkillId) continue;
    forks.total += 1;
    const own = skill.bundleSha256;
    const source = packedById.get(rowKey(skill.tenantId, skill.sourceSkillId));
    if (!own || !source) forks.sourceNotPacked.push(skill.skillId);
    else (own === source ? forks.sameBundleAsSource : forks.differentFromSource).push(skill.skillId);
  }
  const uploaded = await Promise.all([...uploads.values()].map((promise) => promise.then((bytes) => bytes, () => null)));

  return {
    tool: TOOL,
    version: 1,
    mode: options.since ? "delta" : "full",
    dryRun: options.dryRun,
    since: options.since?.toISOString() ?? null,
    deltaMarginMs: options.since ? DELTA_MARGIN_MS : null,
    selectedUpdatedAfter: selectedUpdatedAfter?.toISOString() ?? null,
    target: options.target,
    manifests: manifests.map((manifest) => ({ mode: manifest.mode, startedAt: manifest.startedAt.toISOString(), bundles: manifest.bundles.size })),
    font: { fileName: options.font.fileName, sha256: options.font.sha256 },
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
    totals: {
      skills: skills.length,
      byStatus,
      supabaseObjects: sum((skill) => skill.objects),
      supabaseBytes: sum((skill) => skill.bytes),
      packedFiles: sum((skill) => skill.bundleFiles),
      filteredFiles: sum((skill) => skill.filtered?.length),
      replacedFonts: sum((skill) => skill.replacedFonts?.length),
      corruptFonts: sum((skill) => skill.corruptFonts?.length),
      warnings: sum((skill) => skill.warnings?.length),
      distinctBundles: groups.size,
      bundlesUploaded: uploaded.filter((bytes) => bytes !== null).length,
      uploadedZipBytes: uploaded.reduce<number>((total, bytes) => total + (bytes ?? 0), 0),
    },
    sharedBundles: [...groups.values()].filter((group) => group.skillIds.length > 1)
      .map((group) => ({ ...group, skillIds: group.skillIds.sort() }))
      .sort((a, b) => byCodeUnit(a.tenantId, b.tenantId) || byCodeUnit(a.sha256, b.sha256)),
    forks,
    verification: {
      source: options.dryRun ? "packed" : "bundle-store",
      bundles: verifiedBundles,
      problems: problems.sort((a, b) => byCodeUnit(a.tenantId, b.tenantId) || byCodeUnit(a.sha256, b.sha256) || byCodeUnit(a.problem, b.problem)),
      fonts: fonts.sort((a, b) => byCodeUnit(a.tenantId, b.tenantId) || byCodeUnit(a.bundleSha256, b.bundleSha256) || byCodeUnit(a.path, b.path)),
    },
    supabase: { ...deps.source.stats, retriesByCause: { ...deps.source.stats.retriesByCause } },
    skills,
  };
}

/** 2 when a Skill failed or conflicted, or a bundle failed verification; 0 otherwise, warnings included. */
export function migrationExitCode(report: MigrationReport): 0 | 2 {
  const { failed, conflict } = report.totals.byStatus;
  return failed || conflict || report.verification.problems.length ? 2 : 0;
}

/** The human summary printed after a run. */
export function formatSummary(report: MigrationReport): string {
  const { totals } = report;
  const fontCounts = new Map<string, number>();
  for (const font of report.verification.fonts) {
    const key = `${font.sha256} header ${font.header} ${font.problem ? `invalid (${font.problem})` : "valid"}`;
    fontCounts.set(key, (fontCounts.get(key) ?? 0) + 1);
  }
  const fontLines = [...fontCounts].map(([key, count]) => `${count} x ${key}`);
  const statuses = (["written", "would-write", "unchanged", "kept", "conflict", "failed"] as const)
    .map((status) => `${status} ${totals.byStatus[status] ?? 0}`).join(", ");
  const delta = report.since
    ? `; since ${report.since}: Skills with updated_at > ${report.selectedUpdatedAfter} ` +
      `(built-in margin ${(report.deltaMarginMs ?? 0) / 60_000} min) or without a bundle`
    : "";
  const lines = [
    `${TOOL} ${report.mode}${report.dryRun ? " (dry-run)" : ""}: schema ${report.target.schema}, Supabase bucket ${report.target.supabaseBucket}, ` +
      `OSS bucket ${report.target.ossBucket}${delta}`,
    `Started ${report.startedAt}, finished ${report.finishedAt}; manifests: ${report.manifests.length}`,
    `Skills: ${totals.skills} (${statuses})`,
    `Supabase objects: ${totals.supabaseObjects}, bytes read: ${totals.supabaseBytes}; requests ${report.supabase.requests}, ` +
      `retries ${report.supabase.retries} ${JSON.stringify(report.supabase.retriesByCause)}`,
    `Bundles: distinct bundles: ${totals.distinctBundles}, packed files ${totals.packedFiles}, uploaded ${totals.bundlesUploaded} ` +
      `(${totals.uploadedZipBytes} zip bytes); shared by several Skills: ${report.sharedBundles.length}`,
    `Forks: ${report.forks.total} (same bundle as source ${report.forks.sameBundleAsSource.length}, ` +
      `different ${report.forks.differentFromSource.length}, source not packed ${report.forks.sourceNotPacked.length})`,
    `Filtered files (.pyc, __pycache__): ${totals.filteredFiles}`,
    `Replaced fonts: ${totals.replacedFonts} (with ${report.font.fileName} ${report.font.sha256}); ` +
      `other corrupt fonts kept as stored: ${totals.corruptFonts}`,
    `Verification (${report.verification.source}): ${report.verification.bundles} bundles, ${report.verification.problems.length} problems`,
    `Fonts in verified bundles: ${fontLines.length ? fontLines.join(", ") : "none"}`,
  ];
  for (const problem of report.verification.problems) lines.push(`  problem ${problem.tenantId}/${problem.sha256}: ${problem.problem}`);
  for (const skill of report.skills) {
    if (skill.status === "failed" || skill.status === "conflict" || skill.status === "kept") {
      lines.push(`  ${skill.status} ${skill.tenantId}/${skill.skillId} (${skill.name}): ${skill.reason}`);
    }
    for (const warning of skill.warnings ?? []) lines.push(`  warning ${skill.tenantId}/${skill.skillId} (${skill.name}): ${warning}`);
  }
  const warnings = `${totals.warnings} warning${totals.warnings === 1 ? "" : "s"}`;
  if (migrationExitCode(report)) {
    const count = (n: number | undefined, noun: string) => `${n ?? 0} ${noun}${n === 1 ? "" : "s"}`;
    lines.push(`Result: ${totals.byStatus.failed ?? 0} failed, ${count(totals.byStatus.conflict, "conflict")}, ` +
      `${count(report.verification.problems.length, "verification problem")}; ${warnings} (exit 2)`);
  } else {
    lines.push(`Result: success${totals.warnings ? ` with ${warnings}` : ""} (exit 0)`);
  }
  return lines.join("\n");
}

export interface MigrationArgs {
  schema: string;
  supabaseBucket: string;
  fontPath: string;
  reportPath: string;
  dryRun: boolean;
  since?: Date;
  manifestPaths: string[];
  concurrency: number;
}

export const USAGE = "Usage: migrate-skill-bundles --schema <PG_SCHEMA> --supabase-bucket <S3_BUCKET> --font <LiberationSans-Regular.ttf> " +
  "--report <report.json> [--dry-run] [--since <ISO T0> --manifest <full run report.json> [--manifest <report.json>...]] [--concurrency <1-16>]";

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Parse the command line. `--schema` and `--supabase-bucket` must name what
 * the environment points at (PG_SCHEMA, S3_BUCKET; defaults `oma`,
 * `workspace`), so a run in the wrong Pod fails before it reads anything.
 */
export function parseMigrationArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): MigrationArgs {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        schema: { type: "string" },
        "supabase-bucket": { type: "string" },
        font: { type: "string" },
        report: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        since: { type: "string" },
        manifest: { type: "string", multiple: true, default: [] },
        concurrency: { type: "string", default: "4" },
      },
    }));
  } catch (error) {
    // node:util's messages quote only the command line.
    throw new MigrationError(`${(error as Error).message}\n${USAGE}`);
  }
  const required = (flag: "schema" | "supabase-bucket" | "font" | "report") => {
    const value = values[flag];
    if (!value) throw new MigrationError(`Missing --${flag}\n${USAGE}`);
    return value;
  };
  const schema = required("schema");
  const supabaseBucket = required("supabase-bucket");
  const fontPath = required("font");
  const reportPath = required("report");
  const manifestPaths = values.manifest;
  const envSchema = env.PG_SCHEMA || "oma";
  const envBucket = env.S3_BUCKET || "workspace";
  if (schema !== envSchema) throw new MigrationError(`--schema ${schema} does not match the environment: PG_SCHEMA is "${envSchema}"`);
  if (supabaseBucket !== envBucket) throw new MigrationError(`--supabase-bucket ${supabaseBucket} does not match the environment: S3_BUCKET is "${envBucket}"`);
  let since: Date | undefined;
  if (values.since !== undefined) {
    since = new Date(values.since);
    if (!ISO_WITH_ZONE.test(values.since) || Number.isNaN(since.getTime())) {
      throw new MigrationError("--since must be an ISO 8601 timestamp with a time zone, e.g. 2026-10-23T08:00:00.000Z");
    }
    if (!manifestPaths.length) throw new MigrationError("--since needs the full run's report as --manifest");
  }
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new MigrationError("--concurrency must be an integer from 1 to 16");
  return { schema, supabaseBucket, fontPath, reportPath, dryRun: values["dry-run"], since, manifestPaths, concurrency };
}
