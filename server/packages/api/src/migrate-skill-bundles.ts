import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Agent } from "undici";
import { OSSSkillBundleStore, createPgPool, pgConfigFromEnv } from "@oma-server/store";
import { skillBundleStorageConfigFromEnv } from "./lib/workspace-config.js";
import { MigrationError, safeErrorMessage } from "./skill-bundle-migration/errors.js";
import { loadReplacementFont } from "./skill-bundle-migration/fonts.js";
import { SupabaseSkillReader } from "./skill-bundle-migration/supabase-reader.js";
import { PgSkillRows, formatSummary, migrateSkillBundles, parseManifest, parseMigrationArgs } from "./skill-bundle-migration/migration.js";

/*
 * One-time migration of Supabase Skill files into Skill Bundles (#266, ADR-0022).
 * Removed together with the Supabase Skill data (#272).
 *
 * Supabase Storage and PostgreSQL are VPC-only, so the tool runs inside the
 * environment's API Pod, which has PG_*, S3_ENDPOINT/SUPABASE_SERVICE_KEY,
 * S3_BUCKET and WORKSPACE_OSS_*. The deployed image predates this file, so
 * `deploy/scripts/run-skill-bundle-migration.sh` bundles it with esbuild,
 * copies it and the font into the Pod, runs it with node, copies the report
 * back and deletes the copies. Get the font first (see `fonts.ts`):
 *
 *   curl -fsSLO https://github.com/liberationfonts/liberation-fonts/files/7261482/liberation-fonts-ttf-2.1.5.tar.gz
 *   tar -xzf liberation-fonts-ttf-2.1.5.tar.gz liberation-fonts-ttf-2.1.5/LiberationSans-Regular.ttf
 *   export OMA_FONT=$PWD/liberation-fonts-ttf-2.1.5/LiberationSans-Regular.ttf
 *
 * Modes (wrapper: `run-skill-bundle-migration.sh <test|production> <local report.json> [flags]`):
 *
 *   --dry-run                 read, repair, pack and verify in memory; write nothing (works before migration 0022)
 *   (no mode flag)            full: every Skill; needs migration 0022 applied to the schema
 *   --since <T0> --manifest <full report.json>
 *                             delta: Skills with updated_at > T0 - 10 min (a built-in margin: the old API
 *                             bumps updated_at before it writes Supabase, and Pod clocks skew), plus every
 *                             Skill without a bundle. T0 is the full run's `startedAt`, as is; a T0 later than
 *                             the earliest full run's `startedAt` among the manifests is refused.
 *   --manifest <report.json>  repeatable: rows whose bundle is still one a previous run recorded may be
 *                             refreshed; any other non-NULL bundle (the new API's) is kept
 *
 * Rollout (ADR-0022): full run at T0 → deploy API + Runner → delta with
 * `--since <full startedAt> --manifest <full report>`. Rerunning with the
 * previous reports as manifests writes nothing for unchanged Skills.
 *
 * Output: the JSON report at --report (per-Skill bundle sha256/size, filtered
 * and replaced files, skipped/failed Skills with reasons, Supabase retries) and
 * a summary on stdout; progress on stderr. No credential, URL or Skill file
 * content is printed. Exit code 2 when a Skill failed or conflicted, or a
 * bundle failed verification.
 */

/** A local input file; Node's own error would be printed as its code only. */
function readInput(path: string, what: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    throw new MigrationError(`Cannot read the ${what} ${path}: ${safeErrorMessage(error)}`);
  }
}

/** The environment's own configuration errors name a variable, never its value. */
function fromEnv<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw new MigrationError((error as Error).message);
  }
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new MigrationError(`The ${what} is not JSON`);
  }
}

async function main(): Promise<void> {
  const args = parseMigrationArgs(process.argv.slice(2), process.env);
  const font = loadReplacementFont(new Uint8Array(readInput(args.fontPath, "font")));
  const oss = fromEnv(() => skillBundleStorageConfigFromEnv(process.env));
  const target = { schema: args.schema, supabaseBucket: args.supabaseBucket, ossBucket: oss.bucket };
  const manifests = args.manifestPaths.map((path) =>
    parseManifest(parseJson(readInput(path, "manifest").toString("utf8"), `manifest ${path}`), target));
  // What the API and Runner Pods set (deploy/app/api-runner.yaml).
  const endpoint = process.env.S3_ENDPOINT;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!endpoint || !serviceKey) throw new MigrationError("Supabase Storage needs S3_ENDPOINT and SUPABASE_SERVICE_KEY");
  // As in bootstrap: keep internal Storage off any HTTP proxy.
  const dispatcher = new Agent();
  const directFetch: typeof fetch = (input, init) => fetch(input, { ...init, dispatcher } as RequestInit);
  const pool = createPgPool({ ...fromEnv(() => pgConfigFromEnv()), max: 4 });
  try {
    const { rows: [connected] } = await pool.query<{ schema: string | null }>("SELECT current_schema() AS schema");
    if (connected?.schema !== args.schema) throw new MigrationError(`Connected to schema ${connected?.schema}, not ${args.schema}`);
    const report = await migrateSkillBundles({
      rows: new PgSkillRows(pool),
      source: new SupabaseSkillReader({ endpoint, serviceKey, bucket: args.supabaseBucket, fetch: directFetch, concurrency: args.concurrency }),
      // No cache: the read-back after each upload must be a real OSS read.
      bundles: new OSSSkillBundleStore({ ...oss, cacheBytes: 0 }),
    }, { dryRun: args.dryRun, since: args.since, manifests, font, target, log: (line) => console.error(line) });
    mkdirSync(dirname(args.reportPath), { recursive: true });
    writeFileSync(args.reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(formatSummary(report));
    console.log(`Report: ${args.reportPath}`);
    if (report.totals.byStatus.failed || report.totals.byStatus.conflict || report.verification.problems.length) process.exitCode = 2;
  } finally {
    await pool.end();
    await dispatcher.close();
  }
}

main().catch((error: unknown) => {
  console.error(`migrate-skill-bundles: ${safeErrorMessage(error)}`);
  process.exitCode = 1;
});
