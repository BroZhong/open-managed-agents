import { main } from "./skill-bundle-migration/cli.js";

/*
 * One-time migration of Supabase Skill files into Skill Bundles (#266, ADR-0022).
 * Removed together with the Supabase Skill data (#272).
 *
 * Supabase Storage and PostgreSQL are VPC-only, so the tool runs inside the
 * environment's API Pod, which has PG_*, S3_ENDPOINT/SUPABASE_SERVICE_KEY,
 * S3_BUCKET and WORKSPACE_OSS_*. The deployed image predates this file, so
 * `deploy/scripts/run-skill-bundle-migration.sh` bundles it with esbuild,
 * copies it, the font and the manifests into the Pod, runs it with node,
 * copies the report and the ownership journal back (also when the run fails)
 * and deletes the copies. Get the font first (see `fonts.ts`):
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
 *   --manifest <report.json | journal.jsonl>
 *                             repeatable: a previous real run's report or, if it died before writing one, its
 *                             ownership journal. Rows whose bundle is one those runs claimed may be refreshed;
 *                             any other non-NULL bundle (the new API's) is kept
 *
 * Ownership journal: a real run creates `<report>.journal.jsonl` beside the
 * report (and refuses to start if it exists) and appends, fsynced, one claim
 * per Skill before writing its row (`skill-bundle-migration/journal.ts`). A
 * run that dies midway leaves no report, but its journal: pass it as
 * --manifest to every later run, or the rows it wrote are kept forever.
 *
 * Rollout (ADR-0022): full run at T0 → deploy API + Runner → delta with
 * `--since <full startedAt> --manifest <full report>`. Rerunning with the
 * previous reports as manifests writes nothing for unchanged Skills.
 *
 * Output: the JSON report at --report (per-Skill bundle sha256/size, filtered
 * and replaced files, skipped/failed Skills with reasons, Supabase retries) and
 * a summary on stdout; progress on stderr. No credential, URL or Skill file
 * content is printed: an error the tool did not compose itself (ali-oss, pg)
 * is reported by name, code and HTTP status only.
 *
 * Fonts: every corrupted LiberationSans-Regular.ttf is replaced by the official
 * file. Any other corrupt font is published as stored (it was already corrupt;
 * blocking its Skill would be worse) and reported as a warning.
 *
 * Exit code: 0 on success, warnings included (the summary's last line says
 * "success with N warnings"); 2 when a Skill failed or conflicted, or a bundle
 * failed verification; 1 when the run could not start or broke off.
 */

main(process.argv.slice(2), process.env).then((code) => {
  process.exitCode = code;
});
