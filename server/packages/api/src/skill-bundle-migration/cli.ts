import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Agent } from "undici";
import { OSSSkillBundleStore, createPgPool, pgConfigFromEnv, type OSSObjectClient, type Pool } from "@oma-server/store";
import { skillBundleStorageConfigFromEnv } from "../lib/workspace-config.js";
import { MigrationError, safeErrorMessage } from "./errors.js";
import { loadReplacementFont, type PinnedFont } from "./fonts.js";
import { FileOwnershipJournal, journalPathFor } from "./journal.js";
import {
  PgSkillRows, formatSummary, migrateSkillBundles, migrationExitCode, parseManifest, parseMigrationArgs,
} from "./migration.js";
import { SupabaseSkillReader } from "./supabase-reader.js";

/** The command line of `migrate-skill-bundles.ts`, documented there. */

type Env = Readonly<Record<string, string | undefined>>;

export interface CliOptions {
  stdout?: (text: string) => void;
  stderr?: (line: string) => void;
  /** Test seams: a run builds each of these from the environment. */
  pool?: Pool;
  fetch?: typeof fetch;
  ossClient?: OSSObjectClient;
  pinnedFont?: PinnedFont;
}

/** A local input file; Node's own error would be printed as its code only. */
function readInput(path: string, what: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    throw new MigrationError(`Cannot read the ${what} ${path}: ${safeErrorMessage(error)}`);
  }
}

/** The environment's configuration errors name a variable, never its value. */
function fromEnv<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw new MigrationError((error as Error).message);
  }
}

/** Run the migration; resolves to the exit code: 0 success (warnings included), 2 failed Skills, 1 no run. */
export async function main(argv: readonly string[], env: Env, options: CliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => console.log(text));
  const stderr = options.stderr ?? ((line: string) => console.error(line));
  const closers: Array<() => unknown> = [];
  try {
    const args = parseMigrationArgs(argv, env);
    const font = loadReplacementFont(new Uint8Array(readInput(args.fontPath, "font")), options.pinnedFont);
    const oss = fromEnv(() => skillBundleStorageConfigFromEnv(env));
    const target = { schema: args.schema, supabaseBucket: args.supabaseBucket, ossBucket: oss.bucket };
    const manifests = args.manifestPaths.map((path) => {
      try {
        return parseManifest(readInput(path, "manifest").toString("utf8"), target);
      } catch (error) {
        throw new MigrationError(`${path}: ${safeErrorMessage(error)}`);
      }
    });
    // What the API and Runner Pods set (deploy/app/api-runner.yaml).
    const endpoint = env.S3_ENDPOINT;
    const serviceKey = env.SUPABASE_SERVICE_KEY;
    if (!endpoint || !serviceKey) throw new MigrationError("Supabase Storage needs S3_ENDPOINT and SUPABASE_SERVICE_KEY");
    let fetchImpl = options.fetch;
    if (!fetchImpl) {
      // As in bootstrap: keep internal Storage off any HTTP proxy.
      const dispatcher = new Agent();
      closers.push(() => dispatcher.close());
      fetchImpl = (input, init) => fetch(input, { ...init, dispatcher } as RequestInit);
    }
    let pool = options.pool;
    if (!pool) {
      const own = createPgPool({ ...fromEnv(() => pgConfigFromEnv(env)), max: 4 });
      closers.push(() => own.end());
      pool = own;
    }
    const { rows: [connected] } = await pool.query<{ schema: string | null }>("SELECT current_schema() AS schema");
    if (connected?.schema !== args.schema) throw new MigrationError(`Connected to schema ${connected?.schema}, not ${args.schema}`);
    mkdirSync(dirname(args.reportPath), { recursive: true });
    const journal = args.dryRun ? undefined : new FileOwnershipJournal(journalPathFor(args.reportPath));
    if (journal) closers.push(() => journal.close());
    const report = await migrateSkillBundles({
      rows: new PgSkillRows(pool),
      source: new SupabaseSkillReader({ endpoint, serviceKey, bucket: args.supabaseBucket, fetch: fetchImpl, concurrency: args.concurrency }),
      // No cache: the read-back after each upload must be a real OSS read.
      bundles: new OSSSkillBundleStore({ ...oss, client: options.ossClient, cacheBytes: 0 }),
      journal,
    }, { dryRun: args.dryRun, since: args.since, manifests, font, target, log: stderr });
    writeFileSync(args.reportPath, `${JSON.stringify(report, null, 2)}\n`);
    stdout(formatSummary(report));
    stdout(`Report: ${args.reportPath}${journal ? `; ownership journal: ${journal.path}` : ""}`);
    return migrationExitCode(report);
  } catch (error) {
    stderr(`migrate-skill-bundles: ${safeErrorMessage(error)}`);
    return 1;
  } finally {
    for (const close of closers.reverse()) {
      try {
        await close();
      } catch {
        // Closing never changes the outcome.
      }
    }
  }
}
