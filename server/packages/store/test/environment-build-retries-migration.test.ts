import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPgStores, PgEnvironmentStore } from "../src/index.js";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";

const migration = (name: string) => readFile(new URL(`../../../../deploy/migrations/${name}`, import.meta.url), "utf8");
const LEASE = 60_000;

// Real PostgreSQL only, as for 0024–0028: pg-mem does not run these ALTERs faithfully.
describe.skipIf(!process.env.PG_TEST_URL)("migration 0030: Environment Builds count retries apart from attempts (ADR-0024)", () => {
  let harness: PgTestHarness;
  /** A migration as the environment runner would apply it, to the harness's schema. */
  const apply = async (name: string) => harness.pool.query((await migration(name)).replaceAll("oma.", `${harness.schema}.`));
  const column = async () => (await harness.pool.query(
    `SELECT is_nullable, column_default, data_type FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = 'environment_builds' AND column_name = 'retries'`, [harness.schema])).rows;

  beforeEach(async () => {
    if (!harness) harness = await createPgTestHarness(); else await harness.reset();
    // The schema as 0029 left it, with a build running under an expired lease.
    await harness.pool.query("ALTER TABLE environment_builds DROP COLUMN retries");
    const { environmentStore } = await createPgStores(harness.pool, { ensureSchema: false });
    await environmentStore.create({
      id: "env_old", owner: { ownerType: "tenant", tenantId: "t1" }, name: "old", description: "",
      baseImage: "oma-base", initScript: "true\n", env: [], encryptedSecrets: {},
    });
    await harness.pool.query(`UPDATE environment_builds SET status = 'running', attempts = 2, lease_owner = 'gone',
      lease_expires_at = clock_timestamp() - interval '1 second', started_at = clock_timestamp()`);
  });
  afterAll(async () => { await harness?.close(); });

  it("adds a count that starts at 0 for existing builds; a reclaim does not add to it, a retry does", async () => {
    await apply("0030_environment_build_retries.sql");
    expect(await column()).toEqual([{ is_nullable: "NO", column_default: "0", data_type: "integer" }]);
    const store = new PgEnvironmentStore(harness.pool);
    const claimed = (await store.claimBuild("builder", LEASE))!;
    expect(claimed).toMatchObject({ reclaimed: true, build: { attempts: 3, retries: 0 } });
    await store.retryBuild(claimed.lease, LEASE);
    expect(await store.getBuild("env_old", claimed.build.id)).toMatchObject({ attempts: 4, retries: 1 });
  });

  it("rolls back to the 0029 schema keeping every build, and migrates again", async () => {
    await apply("0030_environment_build_retries.sql");
    await apply("0030_environment_build_retries.rollback.sql");
    expect(await column()).toEqual([]);
    expect((await harness.pool.query("SELECT attempts FROM environment_builds")).rows).toEqual([{ attempts: 2 }]);
    await apply("0030_environment_build_retries.sql");
    expect((await new PgEnvironmentStore(harness.pool).listBuilds("env_old"))[0]).toMatchObject({ attempts: 2, retries: 0 });
  });
});
