import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OSSSkillBundleStore, packSkillBundle, type OSSObjectClient, type Pool } from "@oma-server/store";
import { createPgTestHarness, type PgTestHarness } from "../../store/test/pg-harness.js";
import { fakeOSS, ossTestOptions } from "../../store/test/oss-harness.js";
import { fontProblem, loadReplacementFont } from "../src/skill-bundle-migration/fonts.js";
import { SupabaseSkillReader } from "../src/skill-bundle-migration/supabase-reader.js";
import {
  PgSkillRows,
  formatSummary,
  migrateSkillBundles,
  parseManifest,
  parseMigrationArgs,
  type MigrationReport,
  type MigrationRunOptions,
} from "../src/skill-bundle-migration/migration.js";
import { fakeSupabaseStorage, pinnedFor, sha256, syntheticFont, text, utf8Mangled } from "./fixtures/skill-bundle-migration.js";

const SERVICE_KEY = "supabase-service-role-jwt-secret";
const TENANT = "f00c7d5a-dd14-43e6-b791-e561c192d312";
const FONT_PATH = "assets/fonts/LiberationSans-Regular.ttf";
const TARGET = { schema: "oma_test", supabaseBucket: "workspace-test", ossBucket: "agentry" };
const official = syntheticFont(0x00010000, 7);
const font = loadReplacementFont(official, pinnedFor(official));
const corruptedFont = utf8Mangled(syntheticFont(0x00010000, 9));

interface SeedSkill {
  tenantId?: string;
  skillId: string;
  name: string;
  ownerType?: "library" | "agent";
  sourceSkillId?: string;
  updatedAt: string;
  files: Record<string, Uint8Array>;
}

const preciseSubtitles = (skillMd = "# precise-subtitles\n") => ({
  "SKILL.md": text(skillMd),
  "scripts/burn.py": text("print('subtitles')\n"),
  "scripts/__pycache__/burn.cpython-312.pyc": utf8Mangled(new Uint8Array([0xcb, 0x0d, 0x0d, 0x0a, 0xff, 0x00])),
  [FONT_PATH]: corruptedFont,
  "assets/fonts/LICENSE.txt": text("SIL Open Font License\n"),
});

const SEED: SeedSkill[] = [
  { skillId: "skill_lib", name: "precise-subtitles", updatedAt: "2026-10-01T00:00:00.000Z", files: preciseSubtitles() },
  { skillId: "skill_fork1", name: "precise-subtitles", ownerType: "agent", sourceSkillId: "skill_lib", updatedAt: "2026-10-02T00:00:00.000Z", files: preciseSubtitles() },
  { skillId: "skill_fork2", name: "precise-subtitles", ownerType: "agent", sourceSkillId: "skill_lib", updatedAt: "2026-10-03T00:00:00.000Z", files: preciseSubtitles("# edited fork\n") },
  { skillId: "skill_other", name: "vfs", updatedAt: "2026-10-04T00:00:00.000Z", files: { "SKILL.md": text("# vfs\n"), "a.pyc": new Uint8Array([1, 2, 3]), "ref/notes.md": text("notes") } },
  { skillId: "skill_nomd", name: "broken", updatedAt: "2026-10-05T00:00:00.000Z", files: { "README.md": text("no skill file") } },
  { tenantId: "bad.tenant", skillId: "skill_bad", name: "bad", updatedAt: "2026-10-06T00:00:00.000Z", files: { "SKILL.md": text("# bad\n") } },
];

function countingOSS() {
  const fake = fakeOSS();
  const calls = { put: 0, get: 0 };
  const client: OSSObjectClient = {
    ...fake.client,
    async put(name, body, options) { calls.put += 1; return fake.client.put(name, body, options); },
    async get(name) { calls.get += 1; return fake.client.get(name); },
  };
  return { client, objects: fake.objects, calls };
}

async function insertSkill(pool: Pool, skill: Omit<SeedSkill, "files">) {
  const tenantId = skill.tenantId ?? TENANT;
  const ownerType = skill.ownerType ?? "library";
  await pool.query(
    `INSERT INTO skills (skill_id, tenant_id, name, description, owner_type, owner_id, source_skill_id, created_at, updated_at)
     VALUES ($1, $2, $3, 'd', $4, $5, $6, $7, $7)`,
    [skill.skillId, tenantId, skill.name, ownerType, ownerType === "library" ? tenantId : `agent_of_${skill.skillId}`, skill.sourceSkillId ?? null, new Date(skill.updatedAt)],
  );
}

describe("migrateSkillBundles", () => {
  let harness: PgTestHarness;
  let storage: ReturnType<typeof fakeSupabaseStorage>;
  let oss: ReturnType<typeof countingOSS>;
  let store: OSSSkillBundleStore;
  let logs: string[];

  const seedFiles = (skill: SeedSkill) => {
    for (const [path, body] of Object.entries(skill.files)) storage.put(`${skill.tenantId ?? TENANT}/skills/${skill.skillId}/${path}`, body);
  };
  const reader = () => new SupabaseSkillReader({
    endpoint: "http://storage.internal/storage/v1", serviceKey: SERVICE_KEY, bucket: "workspace-test", fetch: storage.fetch, sleep: async () => {},
  });
  const deps = () => ({ rows: new PgSkillRows(harness.pool), source: reader(), bundles: store });
  const run = (options: Partial<MigrationRunOptions> = {}) => migrateSkillBundles(deps(), {
    dryRun: false, font, target: TARGET, now: () => new Date("2026-10-10T00:00:00.000Z"), log: (line) => logs.push(line), ...options,
  });
  const entry = (report: MigrationReport, skillId: string) => report.skills.find((skill) => skill.skillId === skillId)!;
  /** The repaired font as unpacked from the bundles of the edited fork and of the Library Skill (which its unedited fork shares). */
  const verifiedFonts = (report: MigrationReport) => [entry(report, "skill_fork2"), entry(report, "skill_lib")]
    .map((skill) => ({
      tenantId: TENANT, bundleSha256: skill.bundleSha256, path: FONT_PATH, sha256: sha256(official), size: official.byteLength,
      header: "00010000", problem: null,
    }))
    .sort((a, b) => (a.bundleSha256! < b.bundleSha256! ? -1 : 1));
  const rows = async () => (await harness.pool.query<{ skill_id: string; bundle_sha256: string | null; bundle_size: string | null; updated_at: Date }>(
    "SELECT skill_id, bundle_sha256, bundle_size, updated_at FROM skills ORDER BY skill_id")).rows
    .map((row) => ({ ...row, bundle_size: row.bundle_size == null ? null : Number(row.bundle_size), updated_at: new Date(row.updated_at).toISOString() }));

  beforeEach(async () => {
    harness = await createPgTestHarness();
    storage = fakeSupabaseStorage();
    oss = countingOSS();
    store = new OSSSkillBundleStore({ ...ossTestOptions, client: oss.client, cacheBytes: 0 });
    logs = [];
    for (const skill of SEED) {
      await insertSkill(harness.pool, skill);
      seedFiles(skill);
    }
  });
  afterEach(async () => { await harness.close(); });

  it("dry-runs every Skill: reads, packs, repairs and reports without writing anything", async () => {
    const before = await rows();
    const report = await run({ dryRun: true });
    expect(report).toMatchObject({ mode: "full", dryRun: true, since: null, target: TARGET, startedAt: "2026-10-10T00:00:00.000Z" });
    expect(report.skills.map((skill) => [skill.skillId, skill.status])).toEqual([
      ["skill_bad", "failed"], ["skill_fork1", "would-write"], ["skill_fork2", "would-write"],
      ["skill_lib", "would-write"], ["skill_nomd", "failed"], ["skill_other", "would-write"],
    ]);
    expect(entry(report, "skill_bad").reason).toMatch(/tenant id/);
    expect(entry(report, "skill_nomd").reason).toBe("no SKILL.md");
    expect(entry(report, "skill_lib")).toMatchObject({
      objects: 5, bundleFiles: 4, filtered: ["scripts/__pycache__/burn.cpython-312.pyc"],
      replacedFonts: [{ path: FONT_PATH, fromSha256: sha256(corruptedFont), toSha256: sha256(official) }],
      previousBundleSha256: null,
    });
    expect(entry(report, "skill_other").filtered).toEqual(["a.pyc"]);
    // Content-identical Library Skill and fork share one bundle; the edited fork does not.
    expect(entry(report, "skill_fork1").bundleSha256).toBe(entry(report, "skill_lib").bundleSha256);
    expect(entry(report, "skill_fork2").bundleSha256).not.toBe(entry(report, "skill_lib").bundleSha256);
    expect(report.sharedBundles).toEqual([{ tenantId: TENANT, sha256: entry(report, "skill_lib").bundleSha256, skillIds: ["skill_fork1", "skill_lib"] }]);
    expect(report.forks).toEqual({ total: 2, sameBundleAsSource: ["skill_fork1"], differentFromSource: ["skill_fork2"], sourceNotPacked: [] });
    const objects = SEED.reduce((total, skill) => total + Object.keys(skill.files).length, 0);
    const readBytes = SEED.filter((skill) => skill.skillId !== "skill_nomd" && skill.skillId !== "skill_bad")
      .reduce((total, skill) => total + Object.values(skill.files).reduce((sum, body) => sum + body.byteLength, 0), 0);
    expect(report.totals).toMatchObject({
      skills: 6, supabaseObjects: objects - 1 /* bad tenant is never listed */, supabaseBytes: readBytes,
      byStatus: { "would-write": 4, failed: 2 }, distinctBundles: 3, filteredFiles: 4, replacedFonts: 3, corruptFonts: 0,
      bundlesUploaded: 0,
    });
    expect(report.verification).toEqual({ source: "packed", bundles: 3, problems: [], fonts: verifiedFonts(report) });
    expect(oss.objects.size).toBe(0);
    expect(await rows()).toEqual(before);
  });

  it("uploads each distinct bundle once and records it with direct SQL that leaves updated_at alone", async () => {
    const before = await rows();
    const report = await run();
    expect(report.totals.byStatus).toEqual({ written: 4, failed: 2 });
    expect(report.totals.bundlesUploaded).toBe(3);
    expect(oss.calls.put).toBe(3);
    const lib = entry(report, "skill_lib");
    expect([...oss.objects.keys()].sort()).toEqual([lib, entry(report, "skill_fork2"), entry(report, "skill_other")]
      .map((skill) => `__oma/skills/${TENANT}/${skill.bundleSha256}.zip`).sort());
    const after = await rows();
    expect(after.map((row) => row.updated_at)).toEqual(before.map((row) => row.updated_at));
    expect(after.map((row) => [row.skill_id, row.bundle_sha256, row.bundle_size])).toEqual(report.skills.map((skill) =>
      [skill.skillId, skill.status === "written" ? skill.bundleSha256 : null, skill.status === "written" ? skill.bundleSize : null]));
    // Read back through the bundle store: a valid font, no compiled Python.
    const files = (await store.readAll(TENANT, lib.bundleSha256!))!;
    expect(files.map((file) => file.path)).toEqual(["SKILL.md", "assets/fonts/LICENSE.txt", FONT_PATH, "scripts/burn.py"]);
    const fontEntry = files.find((file) => file.path === FONT_PATH)!;
    expect(fontProblem(fontEntry.body)).toBeNull();
    expect(Buffer.from(fontEntry.body).equals(Buffer.from(official))).toBe(true);
    expect(report.verification).toEqual({ source: "bundle-store", bundles: 3, problems: [], fonts: verifiedFonts(report) });
    expect(formatSummary(report)).toContain(`Fonts in verified bundles: 2 x ${sha256(official)} header 00010000 valid`);
  });

  it("reruns with the previous report as manifest: same bundles, no new objects, no writes", async () => {
    const first = await run();
    const putsAfterFirst = oss.calls.put;
    const stateAfterFirst = await rows();
    const second = await run({ manifests: [parseManifest(JSON.parse(JSON.stringify(first)), TARGET)] });
    expect(second.totals.byStatus).toEqual({ unchanged: 4, failed: 2 });
    expect(second.skills.map((skill) => [skill.skillId, skill.bundleSha256, skill.reason])).toEqual(
      first.skills.map((skill) => [skill.skillId, skill.bundleSha256, skill.reason]));
    expect(oss.calls.put).toBe(putsAfterFirst);
    expect(oss.objects.size).toBe(3);
    expect(second.totals.bundlesUploaded).toBe(0);
    expect(second.verification).toEqual(first.verification);
    expect(await rows()).toEqual(stateAfterFirst);
  });

  it("without a manifest never touches a Skill that already has a bundle, and does not even read it", async () => {
    await run();
    const getsBefore = storage.requests.filter((request) => request.kind === "get").length;
    const rerun = await run();
    expect(rerun.totals.byStatus).toEqual({ kept: 4, failed: 2 });
    expect(entry(rerun, "skill_lib").reason).toMatch(/not written by this migration/);
    // Only skill_nomd is listed again; no file of a bundled Skill is read.
    expect(storage.requests.filter((request) => request.kind === "get").length).toBe(getsBefore);
    expect(oss.objects.size).toBe(3);
  });

  it("delta processes only Skills updated after T0 and never overwrites a bundle the new API wrote", async () => {
    const full = await run();
    const manifest = parseManifest(JSON.parse(JSON.stringify(full)), TARGET);
    // After T0, the old API edits a fork in Supabase (bumping updated_at) and creates a Skill...
    storage.put(`${TENANT}/skills/skill_fork2/SKILL.md`, text("# edited after T0\n"));
    await harness.pool.query("UPDATE skills SET updated_at = $1 WHERE skill_id = 'skill_fork2'", [new Date("2026-10-11T00:00:00.000Z")]);
    const created = { skillId: "skill_new", name: "new", updatedAt: "2026-10-12T00:00:00.000Z", files: { "SKILL.md": text("# new\n") } };
    await insertSkill(harness.pool, created);
    seedFiles(created);
    // ...and once live, the new API publishes its own version of another Skill by compare-and-set.
    const apiBundle = await packSkillBundle([{ path: "SKILL.md", body: text("# vfs edited by the new API\n") }]);
    await store.put(TENANT, apiBundle);
    await harness.pool.query("UPDATE skills SET bundle_sha256 = $1, bundle_size = $2, updated_at = $3 WHERE skill_id = 'skill_other'",
      [apiBundle.sha256, apiBundle.size, new Date("2026-10-13T00:00:00.000Z")]);
    // A Library Skill whose Supabase copy changed without an updated_at bump after T0 is out of the delta.
    storage.put(`${TENANT}/skills/skill_lib/SKILL.md`, text("# not selected\n"));

    const delta = await run({ since: new Date("2026-10-10T00:00:00.000Z"), manifests: [manifest] });
    expect(delta).toMatchObject({ mode: "delta", since: "2026-10-10T00:00:00.000Z" });
    expect(delta.skills.map((skill) => [skill.skillId, skill.status])).toEqual([
      ["skill_fork2", "written"], ["skill_new", "written"], ["skill_other", "kept"],
    ]);
    expect(entry(delta, "skill_fork2").previousBundleSha256).toBe(entry(full, "skill_fork2").bundleSha256);
    expect(entry(delta, "skill_fork2").bundleSha256).not.toBe(entry(full, "skill_fork2").bundleSha256);
    expect(entry(delta, "skill_other")).toMatchObject({ previousBundleSha256: apiBundle.sha256, reason: expect.stringMatching(/changed since the manifest/) });
    const state = Object.fromEntries((await rows()).map((row) => [row.skill_id, row.bundle_sha256]));
    expect(state).toMatchObject({
      skill_other: apiBundle.sha256, skill_fork2: entry(delta, "skill_fork2").bundleSha256,
      skill_new: entry(delta, "skill_new").bundleSha256, skill_lib: entry(full, "skill_lib").bundleSha256,
    });

    // A second delta, given both reports, finds nothing left to do.
    const again = await run({ since: new Date("2026-10-10T00:00:00.000Z"), manifests: [manifest, parseManifest(JSON.parse(JSON.stringify(delta)), TARGET)] });
    expect(again.skills.map((skill) => [skill.skillId, skill.status])).toEqual([
      ["skill_fork2", "unchanged"], ["skill_new", "unchanged"], ["skill_other", "kept"],
    ]);
  });

  it("reports a compare-and-set lost to a concurrent edit as a conflict and keeps the other writer's bundle", async () => {
    const pg = new PgSkillRows(harness.pool);
    const racing = {
      hasBundleColumns: () => pg.hasBundleColumns(),
      list: (since?: Date) => pg.list(since),
      async setBundle(...args: Parameters<PgSkillRows["setBundle"]>) {
        if (args[0].skillId === "skill_lib") await harness.pool.query(`UPDATE skills SET bundle_sha256 = '${"f".repeat(64)}', bundle_size = 1 WHERE skill_id = 'skill_lib'`);
        return pg.setBundle(...args);
      },
    };
    const report = await migrateSkillBundles({ rows: racing, source: reader(), bundles: store }, { dryRun: false, font, target: TARGET });
    expect(entry(report, "skill_lib")).toMatchObject({ status: "conflict", reason: expect.stringMatching(/changed concurrently/) });
    expect((await rows()).find((row) => row.skill_id === "skill_lib")?.bundle_sha256).toBe("f".repeat(64));
  });

  it("fails a Skill above 50 MB uncompressed and one with an unpackable path", async () => {
    await harness.pool.query("DELETE FROM skills");
    const big = { skillId: "skill_big", name: "big", updatedAt: "2026-10-01T00:00:00.000Z", files: { "SKILL.md": text("# big\n"), "data.bin": new Uint8Array(50 * 1024 * 1024) } };
    const odd = { skillId: "skill_odd", name: "odd", updatedAt: "2026-10-01T00:00:00.000Z", files: { "SKILL.md": text("# odd\n"), "bad\\name.md": text("x") } };
    for (const skill of [big, odd]) { await insertSkill(harness.pool, skill); seedFiles(skill); }
    const report = await run({ dryRun: true });
    expect(entry(report, "skill_big")).toMatchObject({ status: "failed", reason: expect.stringMatching(/too large/) });
    expect(entry(report, "skill_odd")).toMatchObject({ status: "failed", reason: expect.stringMatching(/backslash/) });
  });

  it("fails a Skill whose listed object vanished instead of packing a partial version", async () => {
    const source = reader();
    const vanishing = {
      list: (tenantId: string, skillId: string) => source.list(tenantId, skillId),
      async read(tenantId: string, skillId: string, path: string) {
        if (skillId === "skill_other" && path === "ref/notes.md") storage.objects.delete(`${TENANT}/skills/skill_other/ref/notes.md`);
        return source.read(tenantId, skillId, path);
      },
      stats: source.stats,
    };
    const report = await migrateSkillBundles({ rows: new PgSkillRows(harness.pool), source: vanishing, bundles: store }, { dryRun: true, font, target: TARGET });
    expect(entry(report, "skill_other")).toMatchObject({ status: "failed", reason: expect.stringMatching(/missing: ref\/notes.md/) });
  });

  it("refuses a real run before migration 0022 but dry-runs without the bundle columns", async () => {
    // The schema before migration 0022.
    await harness.pool.query("DELETE FROM skills WHERE skill_id <> 'skill_other'");
    await harness.pool.query("ALTER TABLE skills DROP COLUMN bundle_sha256");
    await harness.pool.query("ALTER TABLE skills DROP COLUMN bundle_size");
    const pool = harness.pool;
    const legacy = { rows: new PgSkillRows(pool), source: reader(), bundles: store };
    const report = await migrateSkillBundles(legacy, { dryRun: true, font, target: TARGET });
    expect(report.skills.map((skill) => skill.status)).toEqual(["would-write"]);
    await expect(migrateSkillBundles(legacy, { dryRun: false, font, target: TARGET })).rejects.toThrow(/0022/);
  });

  it("guards the delta: it needs the full run's report and a T0 no later than that run's start", async () => {
    const full = parseManifest(JSON.parse(JSON.stringify(await run())), TARGET);
    await expect(run({ since: new Date("2026-10-10T00:00:00.000Z") })).rejects.toThrow(/full run's report/);
    await expect(run({ since: new Date("2026-10-10T00:00:00.001Z"), manifests: [full] })).rejects.toThrow(/later than the full run started/);
  });

  it("never puts a credential or Skill file content into the report, the summary or the log", async () => {
    const secretBody = "TOP-SECRET-SKILL-BODY";
    storage.put(`${TENANT}/skills/skill_other/ref/notes.md`, text(secretBody));
    const report = await run();
    const output = [JSON.stringify(report), formatSummary(report), ...logs].join("\n");
    for (const secret of [SERVICE_KEY, ossTestOptions.accessKeySecret, ossTestOptions.accessKeyId, secretBody, "Signature", "x-oss-"]) {
      expect(output).not.toContain(secret);
    }
    expect(formatSummary(report)).toMatch(/Skills: 6/);
    expect(formatSummary(report)).toMatch(/distinct bundles: 3/);
  });
});

describe("parseManifest", () => {
  const report = (overrides: Record<string, unknown> = {}) => ({
    tool: "migrate-skill-bundles", version: 1, mode: "full", dryRun: false, target: TARGET, startedAt: "2026-10-10T00:00:00.000Z",
    skills: [
      { tenantId: "t", skillId: "s1", status: "written", bundleSha256: "a".repeat(64) },
      { tenantId: "t", skillId: "s2", status: "unchanged", bundleSha256: "b".repeat(64) },
      { tenantId: "t", skillId: "s3", status: "kept", bundleSha256: "c".repeat(64) },
      { tenantId: "t", skillId: "s4", status: "failed" },
    ],
    ...overrides,
  });

  it("maps every Skill whose bundle this migration wrote or confirmed", () => {
    const manifest = parseManifest(report(), TARGET);
    expect(manifest.mode).toBe("full");
    expect(manifest.startedAt.toISOString()).toBe("2026-10-10T00:00:00.000Z");
    expect([...manifest.bundles]).toEqual([["t/s1", "a".repeat(64)], ["t/s2", "b".repeat(64)]]);
  });

  it("rejects a dry-run, another environment and anything that is not this tool's report", () => {
    expect(() => parseManifest(report({ dryRun: true }), TARGET)).toThrow(/dry-run/);
    expect(() => parseManifest(report({ target: { ...TARGET, schema: "oma" } }), TARGET)).toThrow(/oma_test/);
    expect(() => parseManifest(report({ target: { ...TARGET, supabaseBucket: "workspace" } }), TARGET)).toThrow(/workspace-test/);
    expect(() => parseManifest({ hello: "world" }, TARGET)).toThrow(/not a migrate-skill-bundles report/);
  });
});

describe("parseMigrationArgs", () => {
  const env = { PG_SCHEMA: "oma_test", S3_BUCKET: "workspace-test" };
  const base = ["--schema", "oma_test", "--bucket", "workspace-test", "--font", "/tmp/LiberationSans-Regular.ttf", "--report", "/tmp/r.json"];

  it("parses a full, dry-run and delta invocation", () => {
    expect(parseMigrationArgs(base, env)).toEqual({
      schema: "oma_test", bucket: "workspace-test", fontPath: "/tmp/LiberationSans-Regular.ttf", reportPath: "/tmp/r.json",
      dryRun: false, since: undefined, manifestPaths: [], concurrency: 4,
    });
    expect(parseMigrationArgs([...base, "--dry-run", "--concurrency", "2"], env)).toMatchObject({ dryRun: true, concurrency: 2 });
    expect(parseMigrationArgs([...base, "--since", "2026-10-23T08:00:00.000Z", "--manifest", "/tmp/a.json", "--manifest", "/tmp/b.json"], env))
      .toMatchObject({ since: new Date("2026-10-23T08:00:00.000Z"), manifestPaths: ["/tmp/a.json", "/tmp/b.json"] });
  });

  it("requires the operator to name the schema and bucket the environment actually points at", () => {
    expect(() => parseMigrationArgs(base, { PG_SCHEMA: "oma", S3_BUCKET: "workspace-test" })).toThrow(/PG_SCHEMA is "oma"/);
    expect(() => parseMigrationArgs(base, { PG_SCHEMA: "oma_test", S3_BUCKET: "workspace" })).toThrow(/S3_BUCKET is "workspace"/);
    expect(() => parseMigrationArgs(base, {})).toThrow(/PG_SCHEMA is "oma"/);
  });

  it("rejects missing flags, unknown flags, a zoneless T0 and a delta without a manifest", () => {
    expect(() => parseMigrationArgs(base.slice(2), env)).toThrow(/--schema/);
    expect(() => parseMigrationArgs([...base, "--apply"], env)).toThrow(/Unknown argument --apply/);
    expect(() => parseMigrationArgs([...base, "--since", "2026-10-23 08:00", "--manifest", "/tmp/a.json"], env)).toThrow(/ISO/);
    expect(() => parseMigrationArgs([...base, "--since", "2026-10-23T08:00:00Z"], env)).toThrow(/--manifest/);
    expect(() => parseMigrationArgs([...base, "--concurrency", "0"], env)).toThrow(/--concurrency/);
  });
});
