import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPgStores } from "../src/index.js";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";

const migration = (name: string) => readFile(new URL(`../../../../deploy/migrations/${name}`, import.meta.url), "utf8");
const COLUMNS = ["last_error_at", "last_error_code", "last_error_reason", "state_since"];

// Real PostgreSQL only, as for 0024: pg-mem does not run these ALTERs faithfully.
describe.skipIf(!process.env.PG_TEST_URL)("migration 0025: a binding records what the Session API reports of its Sandbox (ADR-0023)", () => {
  let harness: PgTestHarness;
  /** A migration as the environment runner would apply it, to the harness's schema. */
  const apply = async (name: string) => harness.pool.query((await migration(name)).replaceAll("oma.", `${harness.schema}.`));
  const columns = async () => (await harness.pool.query<{ column_name: string; is_nullable: string; column_default: string | null; data_type: string }>(
    `SELECT column_name, is_nullable, column_default, data_type FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = 'delegation_environments' AND column_name = ANY($2) ORDER BY column_name`,
    [harness.schema, COLUMNS])).rows;

  beforeEach(async () => {
    if (!harness) harness = await createPgTestHarness(); else await harness.reset();
    // The schema as 0024 left production.
    await harness.pool.query(`ALTER TABLE delegation_environments ${COLUMNS.map((name) => `DROP COLUMN ${name}`).join(", ")}`);
    await harness.pool.query(`INSERT INTO delegation_environments (id, sandbox_id, creating_since) VALUES
      ('creating', NULL, '2026-10-22T13:20:00Z'), ('ready', 'sandbox-1', NULL), ('cold', NULL, NULL)`);
  });
  afterAll(async () => { await harness?.close(); });

  it("adds the columns, starts a Creating binding's state at its intent and leaves the others unrecorded", async () => {
    await apply("0025_binding_environment_status.sql");
    expect(await columns()).toEqual([
      { column_name: "last_error_at", is_nullable: "YES", column_default: null, data_type: "timestamp with time zone" },
      { column_name: "last_error_code", is_nullable: "YES", column_default: null, data_type: "text" },
      { column_name: "last_error_reason", is_nullable: "YES", column_default: null, data_type: "text" },
      { column_name: "state_since", is_nullable: "YES", column_default: null, data_type: "timestamp with time zone" },
    ]);
    const { delegationStore } = await createPgStores(harness.pool, { ensureSchema: false });
    expect(await delegationStore.sandbox("creating")).toEqual({ state: "creating", since: new Date("2026-10-22T13:20:00Z"), lastError: null });
    expect(await delegationStore.sandbox("ready")).toEqual({ state: "ready", since: null, lastError: null });
    expect(await delegationStore.sandbox("cold")).toEqual({ state: "cold", since: null, lastError: null });
  });

  it("rolls back to the 0024 schema, keeping every binding, and migrates again", async () => {
    await apply("0025_binding_environment_status.sql");
    const { delegationStore } = await createPgStores(harness.pool, { ensureSchema: false });
    await delegationStore.withBindingLock("ready", async () => ({ value: undefined, observed: { failure: { code: "sandbox_unavailable", reason: "mount" } } }));
    await apply("0025_binding_environment_status.rollback.sql");
    expect(await columns()).toEqual([]);
    expect((await harness.pool.query("SELECT id, sandbox_id, creating_since FROM delegation_environments ORDER BY id")).rows).toEqual([
      { id: "cold", sandbox_id: null, creating_since: null },
      { id: "creating", sandbox_id: null, creating_since: new Date("2026-10-22T13:20:00Z") },
      { id: "ready", sandbox_id: "sandbox-1", creating_since: null },
    ]);
    await apply("0025_binding_environment_status.sql");
    expect(await delegationStore.sandbox("ready")).toEqual({ state: "ready", since: null, lastError: null });
  });

  it("matches the DDL a fresh install gets", async () => {
    await apply("0025_binding_environment_status.sql");
    const migrated = await columns();
    await harness.reset();
    expect(await columns()).toEqual(migrated);
  });
});
