import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgPool, PgAdvisoryLeadership, type Pool } from "../src/index.js";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";

// Session-level advisory locks exist only on real PostgreSQL.
describe.skipIf(!process.env.PG_TEST_URL)("one Runner of a schema leads a role, by a session-level advisory lock", () => {
  let harnesses: PgTestHarness[];
  const leaderships: PgAdvisoryLeadership[] = [];
  beforeAll(async () => { harnesses = [await createPgTestHarness(), await createPgTestHarness()]; });
  afterAll(async () => {
    await Promise.all(leaderships.map((leadership) => leadership.close()));
    await Promise.all(harnesses.map((harness) => harness.close()));
  });
  const leadership = (harness: PgTestHarness, role = "sandbox_sweeper") => {
    const created = new PgAdvisoryLeadership({ connectionString: process.env.PG_TEST_URL, schema: harness.schema }, role, "oma-test-runner");
    leaderships.push(created);
    return created;
  };
  /** The backends holding the role's lock in the schema, as an operator lists them. */
  const holders = async (pool: Pool, schema: string, role = "sandbox_sweeper") => (await pool.query<{ application_name: string }>(
    `SELECT a.application_name FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
     WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 2
       AND l.classid = hashtext($1)::oid AND l.objid = hashtext($2)::oid`, [schema, role])).rows.map((row) => row.application_name);

  it("is held by one Runner at a time; the next takes it once the leader closes", async () => {
    const [first, second] = [leadership(harnesses[0]), leadership(harnesses[0])];
    expect(await first.hold()).toBe(true);
    expect(await second.hold()).toBe(false);
    // Holding is asked again every period: the leader keeps it, the other still does not get it.
    expect(await first.hold()).toBe(true);
    expect(await second.hold()).toBe(false);
    expect(await holders(harnesses[0].pool, harnesses[0].schema)).toEqual(["oma-test-runner"]);
    await first.close();
    expect(await first.hold()).toBe(false);
    expect(await second.hold()).toBe(true);
    await second.close();
  });

  it("is a lock of its schema: the Runners of another environment lead their own", async () => {
    const [here, there] = [leadership(harnesses[0]), leadership(harnesses[1])];
    expect(await here.hold()).toBe(true);
    expect(await there.hold()).toBe(true);
    // Another role of the same schema is another lock.
    const other = leadership(harnesses[0], "another_role");
    expect(await other.hold()).toBe(true);
    await Promise.all([here.close(), there.close(), other.close()]);
  });

  it("is lost with its connection, and taken again by whoever asks first", async () => {
    const [first, second] = [leadership(harnesses[0]), leadership(harnesses[0])];
    expect(await first.hold()).toBe(true);
    // The leader's session ends as if its Runner vanished: the database releases its lock.
    await harnesses[0].pool.query(`SELECT pg_terminate_backend(l.pid) FROM pg_locks l
      WHERE l.locktype = 'advisory' AND l.objsubid = 2 AND l.classid = hashtext($1)::oid AND l.objid = hashtext('sandbox_sweeper')::oid`, [harnesses[0].schema]);
    expect(await second.hold()).toBe(true);
    // The former leader finds its connection gone and the lock taken.
    expect(await first.hold()).toBe(false);
    await second.close();
    expect(await first.hold()).toBe(true);
    await first.close();
  });

  it("uses no client of the Runner's pool: the lock's connection is its own", async () => {
    const pool = createPgPool({ connectionString: process.env.PG_TEST_URL, schema: harnesses[0].schema, max: 1, connectionTimeoutMillis: 2_000 });
    try {
      const lead = leadership(harnesses[0]);
      expect(await lead.hold()).toBe(true);
      // The Runner's one pooled client is still free.
      expect((await pool.query<{ one: number }>("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);
      await lead.close();
    } finally { await pool.end(); }
  });
});
