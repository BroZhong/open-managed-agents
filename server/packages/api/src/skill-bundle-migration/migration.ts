import {
  packSkillBundle,
  skillBundleObjectKey,
  unpackSkillBundle,
  isSkillBundleSha256,
  type PackedSkillBundle,
  type Pool,
  type SkillBundleFile,
  type SkillBundleStore,
} from "@oma-server/store";
import { fontProblem, isFontPath, repairFonts, type CorruptFont, type FontReplacement, type ReplacementFont } from "./fonts.js";
import type { SupabaseReadStats } from "./supabase-reader.js";

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
  ownerType: string;
  sourceSkillId: string | null;
  updatedAt: Date;
  /** Null when the row has no bundle, or the schema predates migration 0022. */
  bundleSha256: string | null;
}

export interface SkillRowStore {
  hasBundleColumns(): Promise<boolean>;
  /** Every Skill, or those with `updated_at > since`, ordered by tenant and id. */
  list(since?: Date): Promise<SkillRow[]>;
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

export interface MigrationRunOptions {
  dryRun: boolean;
  /** Delta: only Skills with `updated_at > since`. Requires the full run's report as a manifest. */
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
  ownerType: string;
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
  corruptFonts?: CorruptFont[];
}

export interface MigrationReport {
  tool: "migrate-skill-bundles";
  version: 1;
  mode: "full" | "delta";
  dryRun: boolean;
  since: string | null;
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
    distinctBundles: number;
    bundlesUploaded: number;
    uploadedZipBytes: number;
  };
  /** Bundles referenced by more than one Skill of this run, e.g. a Library Skill and its unedited forks. */
  sharedBundles: Array<{ tenantId: string; sha256: string; skillIds: string[] }>;
  /** Agent Skills compared with their Library source in this run. */
  forks: { total: number; sameBundleAsSource: string[]; differentFromSource: string[]; sourceNotPacked: string[] };
  /** Every distinct bundle unpacked again: from the bundle store on a real run, from memory on a dry run. */
  verification: { source: "bundle-store" | "packed"; bundles: number; problems: Array<{ tenantId: string; sha256: string; problem: string }> };
  supabase: SupabaseReadStats;
  skills: SkillReportEntry[];
}

const TOOL = "migrate-skill-bundles";
/** Any valid digest: lets the store's own key validation judge a tenant id before anything is read. */
const PROBE_SHA256 = "0".repeat(64);
const MAX_REASON = 300;

const rowKey = (tenantId: string, skillId: string) => `${tenantId}/${skillId}`;
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

class SkillFailure extends Error {}

function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, MAX_REASON);
}

function memo<T>(cache: Map<string, Promise<T>>, key: string, create: () => Promise<T>): Promise<T> {
  let promise = cache.get(key);
  if (!promise) {
    promise = create();
    cache.set(key, promise);
  }
  return promise;
}

async function mapPool<T, R>(items: readonly T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** What must hold for every migrated bundle. */
function bundleProblems(files: readonly SkillBundleFile[]): string[] {
  const problems: string[] = [];
  if (!files.some((file) => file.path === "SKILL.md")) problems.push("no SKILL.md");
  for (const file of files) {
    if (file.path.endsWith(".pyc") || file.path.split("/").includes("__pycache__")) problems.push(`compiled Python present: ${file.path}`);
    if (isFontPath(file.path)) {
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

  async list(since?: Date): Promise<SkillRow[]> {
    const bundle = (await this.hasBundleColumns()) ? "bundle_sha256" : "NULL AS bundle_sha256";
    const { rows } = await this.pool.query<{
      tenant_id: string; skill_id: string; name: string; owner_type: string; source_skill_id: string | null;
      updated_at: Date; bundle_sha256: string | null;
    }>(
      `SELECT tenant_id, skill_id, name, owner_type, source_skill_id, updated_at, ${bundle}
       FROM skills ${since ? "WHERE updated_at > $1" : ""} ORDER BY tenant_id, skill_id`,
      since ? [since] : [],
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
    throw new Error(`The manifest is not a ${TOOL} report`);
  }
  if (report.dryRun !== false) throw new Error("A dry-run report cannot be a manifest: it recorded no bundle");
  for (const field of ["schema", "supabaseBucket", "ossBucket"] as const) {
    if (report.target?.[field] !== target[field]) {
      throw new Error(`The manifest is for ${field} ${JSON.stringify(report.target?.[field])}, not ${JSON.stringify(target[field])}`);
    }
  }
  const startedAt = new Date(String(report.startedAt));
  if (Number.isNaN(startedAt.getTime()) || (report.mode !== "full" && report.mode !== "delta")) throw new Error(`The manifest is not a ${TOOL} report`);
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
    if (!fulls.length) throw new Error("A delta (--since) needs the full run's report as --manifest");
    const lastFull = new Date(Math.max(...fulls.map((manifest) => manifest.startedAt.getTime())));
    if (options.since > lastFull) {
      throw new Error(`--since ${options.since.toISOString()} is later than the full run started (${lastFull.toISOString()}): ` +
        "Skills edited during the full run would be missed");
    }
  }
  if (!options.dryRun && !(await deps.rows.hasBundleColumns())) {
    throw new Error(`skills.bundle_sha256 / bundle_size are missing in schema ${options.target.schema}: apply deploy/migrations/0022_skill_bundles.sql first`);
  }
  const owned = new Map<string, string>();
  for (const manifest of manifests) for (const [key, sha256] of manifest.bundles) owned.set(key, sha256);

  const uploads = new Map<string, Promise<number>>();
  const verified = new Map<string, Promise<void>>();
  const problems: MigrationReport["verification"]["problems"] = [];
  const verify = (tenantId: string, sha256: string, load: () => Promise<Uint8Array | null>) =>
    memo(verified, rowKey(tenantId, sha256), async () => {
      const bytes = await load();
      if (!bytes) throw new SkillFailure(`bundle ${sha256} is missing from the bundle store`);
      for (const problem of bundleProblems(await unpackSkillBundle(bytes))) problems.push({ tenantId, sha256, problem });
    });
  const upload = (tenantId: string, packed: PackedSkillBundle) =>
    memo(uploads, rowKey(tenantId, packed.sha256), async () => {
      await deps.bundles.put(tenantId, packed);
      return packed.bytes.byteLength;
    });

  const rows = await deps.rows.list(options.since);
  let done = 0;
  const skills = await mapPool(rows, options.skillConcurrency ?? 4, async (row) => {
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
          skillBundleObjectKey(row.tenantId, PROBE_SHA256);
        } catch {
          throw new SkillFailure("tenant id is not a valid Skill Bundle key segment (^[A-Za-z0-9_-]{1,128}$)");
        }
        const paths = await deps.source.list(row.tenantId, row.skillId);
        entry.objects = paths.length;
        if (!paths.length) throw new SkillFailure("no Supabase objects");
        if (!paths.includes("SKILL.md")) throw new SkillFailure("no SKILL.md");
        const files = await Promise.all(paths.map(async (path) => ({ path, body: await deps.source.read(row.tenantId, row.skillId, path) })));
        entry.bytes = files.reduce((total, file) => total + file.body.byteLength, 0);
        const repaired = repairFonts(files, options.font);
        const packed = await packSkillBundle(repaired.files);
        Object.assign(entry, {
          bundleSha256: packed.sha256, bundleSize: packed.size, bundleFiles: packed.files, zipBytes: packed.bytes.byteLength,
          filtered: packed.filtered, replacedFonts: repaired.replaced, corruptFonts: repaired.corrupt,
        });
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
  });

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
      distinctBundles: groups.size,
      bundlesUploaded: uploaded.filter((bytes) => bytes !== null).length,
      uploadedZipBytes: uploaded.reduce<number>((total, bytes) => total + (bytes ?? 0), 0),
    },
    sharedBundles: [...groups.values()].filter((group) => group.skillIds.length > 1)
      .map((group) => ({ ...group, skillIds: group.skillIds.sort(byCodeUnit) }))
      .sort((a, b) => byCodeUnit(a.tenantId, b.tenantId) || byCodeUnit(a.sha256, b.sha256)),
    forks,
    verification: { source: options.dryRun ? "packed" : "bundle-store", bundles: verified.size, problems },
    supabase: { ...deps.source.stats, retriesByCause: { ...deps.source.stats.retriesByCause } },
    skills,
  };
}

/** The human summary printed after a run. */
export function formatSummary(report: MigrationReport): string {
  const { totals } = report;
  const statuses = (["written", "would-write", "unchanged", "kept", "conflict", "failed"] as const)
    .map((status) => `${status} ${totals.byStatus[status] ?? 0}`).join(", ");
  const lines = [
    `${TOOL} ${report.mode}${report.dryRun ? " (dry-run)" : ""}: schema ${report.target.schema}, Supabase bucket ${report.target.supabaseBucket}, ` +
      `OSS bucket ${report.target.ossBucket}${report.since ? `, since ${report.since}` : ""}`,
    `Started ${report.startedAt}, finished ${report.finishedAt}; manifests: ${report.manifests.length}`,
    `Skills: ${totals.skills} (${statuses})`,
    `Supabase objects: ${totals.supabaseObjects}, bytes read: ${totals.supabaseBytes}; requests ${report.supabase.requests}, ` +
      `retries ${report.supabase.retries} ${JSON.stringify(report.supabase.retriesByCause)}`,
    `Bundles: distinct bundles: ${totals.distinctBundles}, packed files ${totals.packedFiles}, uploaded ${totals.bundlesUploaded} ` +
      `(${totals.uploadedZipBytes} zip bytes); shared by several Skills: ${report.sharedBundles.length}`,
    `Forks: ${report.forks.total} (same bundle as source ${report.forks.sameBundleAsSource.length}, ` +
      `different ${report.forks.differentFromSource.length}, source not packed ${report.forks.sourceNotPacked.length})`,
    `Filtered files (.pyc, __pycache__): ${totals.filteredFiles}`,
    `Replaced fonts: ${totals.replacedFonts} (with ${report.font.fileName} ${report.font.sha256}); corrupt fonts not replaced: ${totals.corruptFonts}`,
    `Verification (${report.verification.source}): ${report.verification.bundles} bundles, ${report.verification.problems.length} problems`,
  ];
  for (const problem of report.verification.problems) lines.push(`  problem ${problem.tenantId}/${problem.sha256}: ${problem.problem}`);
  for (const skill of report.skills) {
    if (skill.status === "failed" || skill.status === "conflict" || skill.status === "kept") {
      lines.push(`  ${skill.status} ${skill.tenantId}/${skill.skillId} (${skill.name}): ${skill.reason}`);
    }
  }
  return lines.join("\n");
}

export interface MigrationArgs {
  schema: string;
  bucket: string;
  fontPath: string;
  reportPath: string;
  dryRun: boolean;
  since?: Date;
  manifestPaths: string[];
  concurrency: number;
}

export const USAGE = "Usage: migrate-skill-bundles --schema <PG_SCHEMA> --bucket <S3_BUCKET> --font <LiberationSans-Regular.ttf> " +
  "--report <report.json> [--dry-run] [--since <ISO T0> --manifest <full-run report.json> [--manifest <report.json>...]] [--concurrency <1-16>]";

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Parse the command line. `--schema` and `--bucket` must name what the
 * environment points at (PG_SCHEMA, S3_BUCKET; defaults `oma`, `workspace`),
 * so a run in the wrong Pod fails before it reads anything.
 */
export function parseMigrationArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): MigrationArgs {
  const values = new Map<string, string>();
  const manifestPaths: string[] = [];
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--dry-run") { dryRun = true; continue; }
    if (!["--schema", "--bucket", "--font", "--report", "--since", "--manifest", "--concurrency"].includes(flag)) {
      throw new Error(`Unknown argument ${flag}\n${USAGE}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value\n${USAGE}`);
    index += 1;
    if (flag === "--manifest") manifestPaths.push(value);
    else values.set(flag, value);
  }
  const required = (flag: string) => {
    const value = values.get(flag);
    if (!value) throw new Error(`Missing ${flag}\n${USAGE}`);
    return value;
  };
  const schema = required("--schema");
  const bucket = required("--bucket");
  const fontPath = required("--font");
  const reportPath = required("--report");
  const envSchema = env.PG_SCHEMA || "oma";
  const envBucket = env.S3_BUCKET || "workspace";
  if (schema !== envSchema) throw new Error(`--schema ${schema} does not match the environment: PG_SCHEMA is "${envSchema}"`);
  if (bucket !== envBucket) throw new Error(`--bucket ${bucket} does not match the environment: S3_BUCKET is "${envBucket}"`);
  let since: Date | undefined;
  const sinceRaw = values.get("--since");
  if (sinceRaw !== undefined) {
    since = new Date(sinceRaw);
    if (!ISO_WITH_ZONE.test(sinceRaw) || Number.isNaN(since.getTime())) {
      throw new Error("--since must be an ISO 8601 timestamp with a time zone, e.g. 2026-10-23T08:00:00.000Z");
    }
    if (!manifestPaths.length) throw new Error("--since needs the full run's report as --manifest");
  }
  const concurrency = Number(values.get("--concurrency") ?? 4);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error("--concurrency must be an integer from 1 to 16");
  return { schema, bucket, fontPath, reportPath, dryRun, since, manifestPaths, concurrency };
}
