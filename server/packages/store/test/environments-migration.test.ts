import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPgStores } from "../src/index.js";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";

const migration = (name: string) => readFile(new URL(`../../../../deploy/migrations/${name}`, import.meta.url), "utf8");
const TABLES = ["environment_builds", "environments"];

// Real PostgreSQL only, as for 0024 and 0025: pg-mem runs no DO blocks.
describe.skipIf(!process.env.PG_TEST_URL)("migration 0026: Environments and their builds (ADR-0024)", () => {
  let harness: PgTestHarness;
  /** A migration as the environment runner would apply it, to the harness's schema. */
  const apply = async (name: string) => harness.pool.query((await migration(name)).replaceAll("oma.", `${harness.schema}.`));
  /** Columns, indexes and constraints of the two tables, comparable across schemas. */
  const shape = async () => {
    const columns = await harness.pool.query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = ANY($2) ORDER BY table_name, ordinal_position`, [harness.schema, TABLES]);
    const indexes = await harness.pool.query<{ tablename: string; indexname: string; indexdef: string }>(
      `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = ANY($2) ORDER BY indexname`,
      [harness.schema, TABLES]);
    const checks = await harness.pool.query(
      `SELECT rel.relname, pg_get_constraintdef(con.oid) AS definition FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid JOIN pg_namespace ns ON ns.oid = rel.relnamespace
       WHERE ns.nspname = $1 AND rel.relname = ANY($2) ORDER BY rel.relname, definition`, [harness.schema, TABLES]);
    const unqualified = (text: string | null) => text?.replaceAll(`${harness.schema}.`, "");
    return {
      columns: columns.rows.map((row) => ({ ...row, column_default: unqualified(row.column_default) })),
      indexes: indexes.rows.map((row) => ({ ...row, indexdef: unqualified(row.indexdef) })),
      checks: checks.rows,
    };
  };

  beforeEach(async () => {
    if (!harness) harness = await createPgTestHarness(); else await harness.reset();
    // The schema as 0025 left production.
    await harness.pool.query("DROP TABLE environment_builds; DROP TABLE environments");
  });
  afterAll(async () => { await harness?.close(); });

  it("with 0030 matches the DDL a fresh install gets", async () => {
    await apply("0026_environments.sql");
    await apply("0030_environment_build_retries.sql");
    const migrated = await shape();
    expect(migrated.columns.length).toBeGreaterThan(0);
    await harness.reset();
    expect(await shape()).toEqual(migrated);
  });

  it("serves the store, rolls back to the 0025 schema and migrates again", async () => {
    await apply("0026_environments.sql");
    const { environmentStore } = await createPgStores(harness.pool, { ensureSchema: false });
    const env = await environmentStore.create({
      id: "env_migrated", owner: { ownerType: "tenant", tenantId: "t1" }, name: "migrated", description: "",
      baseImage: "oma-base", initScript: "true\n", env: [{ name: "A", value: "1" }], encryptedSecrets: {},
    });
    expect(await environmentStore.get("t1", env.id)).toMatchObject({ status: "pending", lastBuild: { status: "pending" } });
    await apply("0026_environments.rollback.sql");
    expect((await shape()).columns).toEqual([]);
    await apply("0026_environments.sql");
    expect(await environmentStore.list("t1")).toEqual([]);
  });
});
