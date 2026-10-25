import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPgStores } from "../src/index.js";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";

const migration = (name: string) => readFile(new URL(`../../../../deploy/migrations/${name}`, import.meta.url), "utf8");
const COLUMNS: Array<[table: string, column: string]> = [
  ["agents", "environment_id"],
  ["delegation_environments", "environment_id"],
  ["delegation_environments", "image"],
  ["sessions", "environment_id"],
];
const IMAGE = "registry.example/welltop/oma-environments@sha256:" + "b".repeat(64);

// Real PostgreSQL only, as for 0024–0026: pg-mem does not run these ALTERs faithfully.
describe.skipIf(!process.env.PG_TEST_URL)("migration 0028: Agents, Sessions and Sandbox Bindings reference their Environment (ADR-0024)", () => {
  let harness: PgTestHarness;
  /** A migration as the environment runner would apply it, to the harness's schema. */
  const apply = async (name: string) => harness.pool.query((await migration(name)).replaceAll("oma.", `${harness.schema}.`));
  const columns = async () => (await harness.pool.query<{ table_name: string; column_name: string; is_nullable: string; column_default: string | null; data_type: string }>(
    `SELECT table_name, column_name, is_nullable, column_default, data_type FROM information_schema.columns
     WHERE table_schema = $1 AND (table_name, column_name) IN (${COLUMNS.map((_, i) => `($${2 * i + 2}, $${2 * i + 3})`).join(", ")})
     ORDER BY table_name, column_name`,
    [harness.schema, ...COLUMNS.flat()])).rows;

  beforeEach(async () => {
    if (!harness) harness = await createPgTestHarness(); else await harness.reset();
    // The schema as 0026 left production.
    for (const [table, column] of COLUMNS) await harness.pool.query(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    const now = new Date("2026-10-26T00:00:00Z");
    await harness.pool.query(`INSERT INTO agents (id, tenant_id, name, model, system, runtime, created_at, updated_at)
      VALUES ('agent_old', 't1', 'Old', 'm', 's', 'pi-agent', $1, $1)`, [now]);
    await harness.pool.query(`INSERT INTO sessions (id, tenant_id, agent_id, status, agent, workspace_id, created_at, updated_at)
      VALUES ('sess_old', 't1', 'agent_old', 'idle', '{"id":"agent_old","createdAt":"2026-10-26T00:00:00Z","updatedAt":"2026-10-26T00:00:00Z"}', 'ws_old', $1, $1)`, [now]);
    await harness.pool.query(`INSERT INTO delegation_environments (id, sandbox_id) VALUES ('sess_old', 'sandbox-old')`);
  });
  afterAll(async () => { await harness?.close(); });

  it("adds nullable columns: existing Agents, Sessions and bindings reference no Environment", async () => {
    await apply("0028_session_environment.sql");
    expect(await columns()).toEqual(COLUMNS.map(([table_name, column_name]) =>
      ({ table_name, column_name, is_nullable: "YES", column_default: null, data_type: "text" })));
    const { agentStore, sessionStore, delegationStore } = await createPgStores(harness.pool, { ensureSchema: false });
    expect((await agentStore.getById("agent_old"))?.environmentId).toBeUndefined();
    expect((await sessionStore.getById("sess_old"))?.environmentId).toBeUndefined();
    expect(await delegationStore.withBindingLock("sess_old", async (row) => ({ value: row })))
      .toMatchObject({ sandboxId: "sandbox-old", environmentId: null, image: null });
  });

  it("serves the stores, rolls back to the 0026 schema keeping every row, and migrates again", async () => {
    await apply("0028_session_environment.sql");
    const { agentStore, sessionStore, delegationStore } = await createPgStores(harness.pool, { ensureSchema: false });
    const agent = await agentStore.create({ tenantId: "t1", name: "Bound", model: "m", system: "s", runtime: "pi-agent", environmentId: "env_a" });
    const session = await sessionStore.create({ tenantId: "t1", agentId: agent.id, agent, workspaceId: "ws_1", environmentId: "env_a" });
    await delegationStore.withBindingLock(session.id, async () => ({ next: { ready: "sandbox-1", environmentId: "env_a", image: IMAGE }, value: undefined }));
    expect(await delegationStore.withBindingLock(session.id, async (row) => ({ value: row })))
      .toMatchObject({ sandboxId: "sandbox-1", environmentId: "env_a", image: IMAGE });

    await apply("0028_session_environment.rollback.sql");
    expect(await columns()).toEqual([]);
    expect((await harness.pool.query("SELECT id FROM agents ORDER BY id")).rows.map((row) => row.id)).toEqual(["agent_old", agent.id].sort());
    expect((await harness.pool.query("SELECT id, sandbox_id FROM delegation_environments ORDER BY id")).rows)
      .toEqual([{ id: "sess_old", sandbox_id: "sandbox-old" }, { id: session.id, sandbox_id: "sandbox-1" }].sort((a, b) => (a.id < b.id ? -1 : 1)));

    await apply("0028_session_environment.sql");
    expect((await agentStore.getById(agent.id))?.environmentId).toBeUndefined();
    expect((await sessionStore.getById(session.id))?.environmentId).toBeUndefined();
  });

  it("matches the DDL a fresh install gets", async () => {
    await apply("0028_session_environment.sql");
    const migrated = await columns();
    await harness.reset();
    expect(await columns()).toEqual(migrated);
  });
});
