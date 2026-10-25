import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPgStores } from "../src/index.js";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";

const migration = (name: string) => readFile(new URL(`../../../../deploy/migrations/${name}`, import.meta.url), "utf8");

// Real PostgreSQL only: pg-mem runs neither the 'epoch' literal nor these ALTERs faithfully.
describe.skipIf(!process.env.PG_TEST_URL)("migration 0024: creating_since replaces creation_pending (ADR-0023)", () => {
  let harness: PgTestHarness;
  /** A migration as the environment runner would apply it, to the harness's schema. */
  const apply = async (name: string) => harness.pool.query((await migration(name)).replaceAll("oma.", `${harness.schema}.`));
  const columns = async () => (await harness.pool.query<{ column_name: string; is_nullable: string; column_default: string | null; data_type: string }>(
    `SELECT column_name, is_nullable, column_default, data_type FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = 'delegation_environments' AND column_name IN ('creating_since', 'creation_pending')`,
    [harness.schema])).rows;
  const rows = async () => Object.fromEntries((await harness.pool.query<Record<string, unknown> & { id: string }>(
    "SELECT * FROM delegation_environments ORDER BY id")).rows.map(({ id, ...row }) => [id, row]));

  beforeEach(async () => {
    if (!harness) harness = await createPgTestHarness(); else await harness.reset();
    // The schema as 0020–0023 left production: creation_pending, no creating_since.
    await harness.pool.query("ALTER TABLE delegation_environments DROP COLUMN creating_since");
    await apply("0020_native_sandbox_lifecycle.sql");
    await harness.pool.query(`INSERT INTO delegation_environments (id, sandbox_id, creation_pending) VALUES
      ('pending', NULL, TRUE), ('ready', 'sandbox-1', FALSE), ('cold', NULL, FALSE)`);
  });
  afterAll(async () => { await harness?.close(); });

  it("turns every pending row into an intent at the epoch and drops the flag", async () => {
    await apply("0024_binding_creating_since.sql");
    expect(await columns()).toEqual([{ column_name: "creating_since", is_nullable: "YES", column_default: null, data_type: "timestamp with time zone" }]);
    const migrated = await rows();
    expect(migrated.pending).toMatchObject({ sandbox_id: null, creating_since: new Date(0) });
    expect(migrated.ready).toMatchObject({ sandbox_id: "sandbox-1", creating_since: null });
    expect(migrated.cold).toMatchObject({ sandbox_id: null, creating_since: null });
    // The first use reads the legacy intent as past any deadline, by the database clock.
    const stores = await createPgStores(harness.pool, { ensureSchema: false });
    const binding = await stores.delegationStore.withBindingLock("pending", async (row) => ({ value: row }));
    expect(binding.creatingSince).toEqual(new Date(0));
    expect(binding.now.getTime() - binding.creatingSince!.getTime()).toBeGreaterThan(180_000);
  });

  it("rolls back to creation_pending, true for every intent, and migrates again", async () => {
    await apply("0024_binding_creating_since.sql");
    // An intent committed after the migration, still within its deadline.
    await harness.pool.query("INSERT INTO delegation_environments (id, sandbox_id, creating_since) VALUES ('fresh', NULL, now())");
    await apply("0024_binding_creating_since.rollback.sql");
    expect(await columns()).toEqual([{ column_name: "creation_pending", is_nullable: "NO", column_default: "false", data_type: "boolean" }]);
    const rolledBack = await rows();
    expect(Object.fromEntries(Object.entries(rolledBack).map(([id, row]) => [id, [row.sandbox_id, row.creation_pending]]))).toEqual({
      cold: [null, false], fresh: [null, true], pending: [null, true], ready: ["sandbox-1", false],
    });
    await apply("0024_binding_creating_since.sql");
    const again = await rows();
    expect(again.fresh).toMatchObject({ creating_since: new Date(0) });
    expect(again.pending).toMatchObject({ creating_since: new Date(0) });
    expect(again.ready).toMatchObject({ sandbox_id: "sandbox-1", creating_since: null });
  });

  it("matches the DDL a fresh install gets", async () => {
    await apply("0024_binding_creating_since.sql");
    const migrated = await columns();
    await harness.reset();
    expect(await columns()).toEqual(migrated);
  });
});
