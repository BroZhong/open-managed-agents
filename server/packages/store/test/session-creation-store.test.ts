import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PgSessionCreationStore } from "../src/postgres/session-creation-store.js";
import { createPgPool } from "../src/postgres/connection.js";
import { PgSessionStore } from "../src/postgres/session-store.js";
import { PgWorkspaceMetadataStore } from "../src/postgres/workspace-metadata-store.js";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";
import type { Agent } from "../src/types.js";

const agent: Agent = { id: "agent_test", tenantId: "t1", name: "Test", model: "m", system: "s", runtime: "mock", createdAt: new Date(), updatedAt: new Date() };
const request = { agentId: agent.id };

describe("PgSessionCreationStore", () => {
  let harness: PgTestHarness;
  let store: PgSessionCreationStore;
  beforeAll(async () => { harness = await createPgTestHarness(); });
  beforeEach(async () => { await harness.reset(); store = new PgSessionCreationStore(harness.pool); });
  afterAll(async () => { await harness.close(); });
  const prepare = async () => ({ agent, environmentId: "env_original" });
  const count = async (table: string) => Number((await harness.pool.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);

  it("persists keys across store instances, bypasses defaults on replay and rejects changes with the Session ID", async () => {
    const first = await store.create("t1", "key", request, prepare);
    await new PgSessionStore(harness.pool).updateStatus(first.id, "running");
    const unused = vi.fn(async () => { throw new Error("must not resolve defaults on replay"); });
    const restarted = new PgSessionCreationStore(harness.pool);
    expect(await restarted.create("t1", "key", request, unused)).toMatchObject({ id: first.id, status: "running", environmentId: "env_original" });
    expect(unused).not.toHaveBeenCalled();
    for (const changed of [{ agentId: "another" }, { workspaceId: "another" }, { workspaceName: "another" }, { environmentId: "env_original" }]) {
      await expect(restarted.create("t1", "key", { ...request, ...changed }, unused)).rejects.toMatchObject({ code: "idempotency_key_conflict", sessionId: first.id });
    }
    expect(await count("sessions")).toBe(1);
    expect(await count("workspaces")).toBe(1);
    expect(await count("session_creation_keys")).toBe(1);
  });

  it("isolates tenants and reuses existing Workspaces without renaming them", async () => {
    const ws = new PgWorkspaceMetadataStore(harness.pool);
    await ws.create({ tenantId: "t1", id: "shared", name: "original" });
    const a = await store.create("t1", "key", { ...request, workspaceId: "shared", workspaceName: "ignored" }, prepare);
    const b = await store.create("t2", "key", request, async () => ({ agent: { ...agent, tenantId: "t2" } }));
    expect(a.id).not.toBe(b.id);
    expect(a.workspaceId).toBe("shared");
    expect((await ws.getById("t1", "shared"))?.name).toBe("original");
  });

  it("does not reserve a key on preparation failure", async () => {
    await expect(store.create("t1", "key", request, async () => { throw new Error("unready"); })).rejects.toThrow("unready");
    expect(await count("session_creation_keys")).toBe(0);
    expect(await count("workspaces")).toBe(0);
    expect((await store.create("t1", "key", request, prepare)).id).toMatch(/^sess_/);
  });

  // pg-mem does not implement transaction rollback or concurrent unique waits.
  // Run these against PG_TEST_URL to prove the production transaction contract.
  it.runIf(Boolean(process.env.PG_TEST_URL))("serializes concurrent creators across instances, including different parameters", async () => {
    const results = await Promise.all(Array.from({ length: 16 }, () => new PgSessionCreationStore(harness.pool).create("t1", "key", request, prepare)));
    expect(new Set(results.map(s => s.id)).size).toBe(1);
    expect(await count("workspaces")).toBe(1);
    expect(await count("sessions")).toBe(1);
    const race = await Promise.allSettled(["A", "B"].map(workspaceName => new PgSessionCreationStore(harness.pool).create("t1", "race", { ...request, workspaceName }, prepare)));
    const won = race.find(r => r.status === "fulfilled")!;
    const lost = race.find(r => r.status === "rejected")!;
    expect(won.status).toBe("fulfilled");
    expect(lost.status).toBe("rejected");
    if (won.status === "fulfilled" && lost.status === "rejected") expect(lost.reason).toMatchObject({ code: "idempotency_key_conflict", sessionId: won.value.id });
    expect(await count("workspaces")).toBe(2);
    expect(await count("session_creation_keys")).toBe(2);
  });

  it.runIf(Boolean(process.env.PG_TEST_URL))("rolls back Workspace and reservation on failed Session insert, allowing a retry", async () => {
    await harness.pool.query("ALTER TABLE sessions ADD CONSTRAINT injected_failure CHECK (agent_id <> 'fail')");
    await expect(store.create("t1", "key", request, async () => ({ agent: { ...agent, id: "fail" } }))).rejects.toThrow();
    expect(await count("workspaces")).toBe(0);
    expect(await count("sessions")).toBe(0);
    expect(await count("session_creation_keys")).toBe(0);
    expect((await store.create("t1", "key", request, prepare)).id).toMatch(/^sess_/);
  });

  it.runIf(Boolean(process.env.PG_TEST_URL))("can resolve defaults and replay with a one-connection pool", async () => {
    const pool = createPgPool({ connectionString: process.env.PG_TEST_URL, schema: harness.schema, max: 1, connectionTimeoutMillis: 1000 });
    try {
      const single = new PgSessionCreationStore(pool);
      const resolve = async () => {
        await pool.query("SELECT 1");
        return prepare();
      };
      const attempts = await Promise.all(Array.from({ length: 3 }, () => single.create("t1", "one-client", request, resolve)));
      expect(new Set(attempts.map(session => session.id)).size).toBe(1);
      expect((await single.create("t1", "one-client", request, resolve)).id).toBe(attempts[0].id);
    } finally { await pool.end(); }
  });

  it.runIf(Boolean(process.env.PG_TEST_URL))("does not consume a key when the Workspace was deleted", async () => {
    const ws = new PgWorkspaceMetadataStore(harness.pool);
    await ws.create({ tenantId: "t1", id: "deleted" });
    await ws.softDelete("t1", "deleted");
    await expect(store.create("t1", "key", { ...request, workspaceId: "deleted" }, prepare)).rejects.toThrow("Workspace has been deleted");
    expect(await count("session_creation_keys")).toBe(0);
    expect((await store.create("t1", "key", request, prepare)).id).toMatch(/^sess_/);
  });
});
