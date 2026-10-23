import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "@oma-server/store";
import { createPgTestHarness, type PgTestHarness } from "../../store/test/pg-harness.js";
import { fakeOSS, ossTestOptions } from "../../store/test/oss-harness.js";
import { main, type CliOptions } from "../src/skill-bundle-migration/cli.js";
import type { MigrationReport } from "../src/skill-bundle-migration/migration.js";
import { fakeSupabaseStorage, pinnedFor, syntheticFont, text, utf8Mangled } from "./fixtures/skill-bundle-migration.js";

const TENANT = "f00c7d5a-dd14-43e6-b791-e561c192d312";
const SERVICE_KEY = "supabase-service-role-jwt-secret";
const official = syntheticFont(0x00010000, 7);

describe("migrate-skill-bundles main", () => {
  let harness: PgTestHarness;
  let storage: ReturnType<typeof fakeSupabaseStorage>;
  let oss: ReturnType<typeof fakeOSS>;
  let dir: string;
  let stdout: string[];
  let stderr: string[];

  const env = () => ({
    PG_SCHEMA: harness.schema, S3_BUCKET: "workspace-test",
    S3_ENDPOINT: "http://storage.internal/storage/v1", SUPABASE_SERVICE_KEY: SERVICE_KEY,
    WORKSPACE_OSS_REGION: ossTestOptions.region, WORKSPACE_OSS_BUCKET: ossTestOptions.bucket,
    WORKSPACE_OSS_ACCESS_KEY_ID: ossTestOptions.accessKeyId, WORKSPACE_OSS_ACCESS_KEY_SECRET: ossTestOptions.accessKeySecret,
  });
  const fontPath = () => join(dir, "LiberationSans-Regular.ttf");
  const argv = (report: string, ...extra: string[]) =>
    ["--schema", harness.schema, "--supabase-bucket", "workspace-test", "--font", fontPath(), "--report", join(dir, report), ...extra];
  const run = (args: string[], overrides: { env?: Record<string, string>; options?: CliOptions } = {}) => main(args, overrides.env ?? env(), {
    pool: harness.pool, fetch: storage.fetch, ossClient: oss.client, pinnedFont: pinnedFor(official),
    stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line), ...overrides.options,
  });
  const readReport = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf8")) as MigrationReport;
  const readJournal = (name: string) => readFileSync(join(dir, name), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
  const seed = async (skillId: string, files: Record<string, Uint8Array>) => {
    await harness.pool.query(
      `INSERT INTO skills (skill_id, tenant_id, name, description, owner_type, owner_id, created_at, updated_at)
       VALUES ($1, $2, $1, 'd', 'library', $2, $3, $3)`, [skillId, TENANT, new Date("2026-10-01T00:00:00.000Z")]);
    for (const [path, body] of Object.entries(files)) storage.put(`${TENANT}/skills/${skillId}/${path}`, body);
  };

  beforeEach(async () => {
    harness = await createPgTestHarness();
    storage = fakeSupabaseStorage();
    oss = fakeOSS();
    dir = mkdtempSync(join(tmpdir(), "oma-skill-bundle-migration-cli-"));
    writeFileSync(fontPath(), official);
    stdout = [];
    stderr = [];
    await seed("skill_a", { "SKILL.md": text("# a\n"), "fonts/LiberationSans-Regular.ttf": utf8Mangled(syntheticFont(0x00010000, 9)) });
    await seed("skill_b", { "SKILL.md": text("# b\n"), "x/__pycache__/y.pyc": new Uint8Array([1]) });
  });
  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    await harness.close();
  });

  it("exits 0 and leaves the report and, beside it, the ownership journal of the run", async () => {
    expect(await run(argv("full.json"))).toBe(0);
    const report = readReport("full.json");
    expect(report.totals.byStatus).toEqual({ written: 2 });
    const [header, ...claims] = readJournal("full.journal.jsonl");
    expect(header).toMatchObject({ kind: "journal", runId: report.runId, mode: "full", startedAt: report.startedAt });
    // Skills run concurrently: claims are in completion order.
    expect(claims.map((claim) => [claim.runId, claim.skillId, claim.sha256, claim.size]).sort()).toEqual(
      report.skills.map((skill) => [report.runId, skill.skillId, skill.bundleSha256, skill.bundleSize]).sort());
    expect(stdout.join("\n")).toContain("Result: success (exit 0)");
    expect(stdout.at(-1)).toBe(`Report: ${join(dir, "full.json")}; ownership journal: ${join(dir, "full.journal.jsonl")}`);
    expect(stderr.filter((line) => line.startsWith("migrate-skill-bundles:"))).toEqual([]);
  });

  it("takes a journal as --manifest: the rerun writes nothing and exits 0", async () => {
    expect(await run(argv("full.json"))).toBe(0);
    const puts = oss.objects.size;
    expect(await run(argv("rerun.json", "--manifest", join(dir, "full.journal.jsonl")))).toBe(0);
    expect(readReport("rerun.json").totals.byStatus).toEqual({ unchanged: 2 });
    expect(readReport("rerun.json").manifests).toMatchObject([{ source: "journal", mode: "full", bundles: 2 }]);
    expect(oss.objects.size).toBe(puts);
  });

  it("exits 0 when the run succeeded with warnings, and says so", async () => {
    await seed("skill_noto", { "SKILL.md": text("# noto\n"), "fonts/NotoSans.ttf": utf8Mangled(syntheticFont(0x00010000, 3)) });
    expect(await run(argv("full.json"))).toBe(0);
    expect(readReport("full.json").totals).toMatchObject({ byStatus: { written: 3 }, warnings: 1 });
    expect(stdout.join("\n")).toContain("Result: success with 1 warning (exit 0)");
  });

  it("exits 2 when a Skill failed, and still writes the report", async () => {
    await seed("skill_nomd", { "README.md": text("no SKILL.md") });
    expect(await run(argv("full.json"))).toBe(2);
    expect(readReport("full.json").totals.byStatus).toEqual({ written: 2, failed: 1 });
    expect(stdout.join("\n")).toContain("Result: 1 failed, 0 conflicts, 0 verification problems; 0 warnings (exit 2)");
  });

  it("exits 1 before reading anything when --schema or --supabase-bucket is not what PG_SCHEMA and S3_BUCKET point at", async () => {
    expect(await run(argv("full.json"), { env: { ...env(), PG_SCHEMA: "oma_test" } })).toBe(1);
    expect(await run(argv("full.json"), { env: { ...env(), S3_BUCKET: "workspace" } })).toBe(1);
    expect(stderr).toEqual([
      `migrate-skill-bundles: --schema ${harness.schema} does not match the environment: PG_SCHEMA is "oma_test"`,
      'migrate-skill-bundles: --supabase-bucket workspace-test does not match the environment: S3_BUCKET is "workspace"',
    ]);
    expect(storage.requests).toEqual([]);
    expect(existsSync(join(dir, "full.json")) || existsSync(join(dir, "full.journal.jsonl"))).toBe(false);
  });

  it("exits 1 when the database connection's schema is not --schema", async () => {
    const args = ["--schema", "oma_test", ...argv("full.json").slice(2)];
    expect(await run(args, { env: { ...env(), PG_SCHEMA: "oma_test" } })).toBe(1);
    expect(stderr).toEqual([`migrate-skill-bundles: Connected to schema ${harness.schema}, not oma_test`]);
    expect(storage.requests).toEqual([]);
  });

  it("exits 1 rather than overwrite an existing ownership journal", async () => {
    writeFileSync(join(dir, "full.journal.jsonl"), "a crashed run's claims\n");
    expect(await run(argv("full.json"))).toBe(1);
    expect(stderr.join("\n")).toMatch(/ownership journal .*full\.journal\.jsonl exists already/);
    expect(readFileSync(join(dir, "full.journal.jsonl"), "utf8")).toBe("a crashed run's claims\n");
    expect(storage.requests).toEqual([]);
  });

  it("exits 1 with only the name, code and HTTP status of an error the tool did not compose", async () => {
    const pool = {
      async query() { throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.7:5432 postgres://oma:secret@pg/oma"), { code: "ECONNREFUSED" }); },
      async end() {},
    } as unknown as Pool;
    expect(await run(argv("full.json"), { options: { pool } })).toBe(1);
    expect(stderr).toEqual(["migrate-skill-bundles: Error code ECONNREFUSED"]);
  });
});
