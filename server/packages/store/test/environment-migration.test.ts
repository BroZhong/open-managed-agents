import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPgStores } from "../src/index.js";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";

const migration = (name: string) => readFile(new URL(`../../../../deploy/migrations/${name}`, import.meta.url), "utf8");
const IMAGE = "registry.example/welltop/oma-environments@sha256:" + "a".repeat(64);
const VIDEO_ENV = [
  { name: "HTTP_PROXY", value: "http://sing-box:7890" },
  { name: "VFS_TOKEN", secretRef: { source: "platform", key: "VFS_TOKEN" } },
  { name: "GOOGLE_API_KEY", secretRef: { source: "platform", key: "GOOGLE_API_KEY" } },
];
const AT = new Date("2026-10-26T00:00:00Z");

// Real PostgreSQL only, as for 0024–0028: pg-mem runs no DO block and lacks
// jsonb_each_text, jsonb_array_elements and jsonb_build_object.
describe.skipIf(!process.env.PG_TEST_URL)("migration 0029: Agents and Sessions move onto Environments (ADR-0024)", () => {
  let harness: PgTestHarness;
  const apply = async (name: string) => harness.pool.query((await migration(name)).replaceAll("oma.", `${harness.schema}.`));
  const query = async <T extends Record<string, unknown>>(sql: string) => (await harness.pool.query<T>(sql)).rows;
  /** Every row the migration may touch, comparable before and after. */
  const state = async () => ({
    agents: await query("SELECT id, sandbox, environment_id FROM agents ORDER BY id"),
    sessions: await query("SELECT id, agent->'sandbox' AS sandbox, environment_id FROM sessions ORDER BY id"),
    environments: await query("SELECT id, tenant_id, name, env, status, image, last_build_id FROM environments ORDER BY id"),
    builds: await query("SELECT id, environment_id, status, definition_sha256 FROM environment_builds ORDER BY id"),
  });
  const agent = (id: string, tenantId: string, sandbox: unknown, environmentId: string | null = null) => harness.pool.query(
    `INSERT INTO agents (id, tenant_id, name, model, system, runtime, sandbox, environment_id, created_at, updated_at)
     VALUES ($1, $2, $3, 'm', 's', 'pi-agent', $4, $5, $6, $6)`, [id, tenantId, `Agent ${id}`, sandbox === null ? null : JSON.stringify(sandbox), environmentId, AT]);
  const session = (id: string, agentId: string, sandbox: unknown, environmentId: string | null = null, parent?: string) => harness.pool.query(
    `INSERT INTO sessions (id, tenant_id, agent_id, status, agent, workspace_id, environment_id, delegation, created_at, updated_at)
     VALUES ($1, 't1', $2, 'idle', $3, 'ws', $4, $5, $6, $6)`,
    [id, agentId, JSON.stringify({ id: agentId, name: "snapshot", ...(sandbox === undefined ? {} : { sandbox }), createdAt: AT, updatedAt: AT }), environmentId,
      JSON.stringify(parent ? { parentSessionId: parent, parentTurnId: "t", parentToolUseId: "u", sandboxSessionId: parent } : null), AT]);
  const builtIn = async (image: string | null = IMAGE) => {
    await harness.pool.query(`INSERT INTO environment_builds (id, environment_id, owner_type, status, base_image, init_script, definition_sha256, created_at, image)
      VALUES ('envb_video', 'env_video_production', 'platform', 'succeeded', 'oma-media', 'apt-get install -y libgl1\n', 'sha-video', $1, $2)`, [AT, image]);
    await harness.pool.query(`INSERT INTO environments (id, owner_type, tenant_id, name, description, base_image, init_script, env, secrets, status, image, manifest, last_build_id, created_at, updated_at)
      VALUES ('env_video_production', 'platform', NULL, 'video-production', 'Video', 'oma-media', 'apt-get install -y libgl1\n', $1, '{}', $2, $3, '{"dpkg":{"ffmpeg":"9"}}', 'envb_video', $4, $4)`,
    [JSON.stringify(VIDEO_ENV), image ? "ready" : "building", image, AT]);
  };

  beforeEach(async () => {
    if (!harness) harness = await createPgTestHarness(); else await harness.reset();
    await agent("agent_plain", "t1", { enabled: true, image: "auto-story-v2" });
    await agent("agent_vars", "t1", { enabled: true, image: "custom:1",
      env: { VFS_TOKEN: "agent-vfs", OWN: "1", HOME: "/elsewhere", EMPTY: "", HTTP_PROXY: "http://agent-proxy", OMA_X: "x" } });
    await agent("agent_off", "t1", { enabled: false, env: { X: "1" } });
    await agent("agent_bare", "t2", null);
    await agent("agent_bound", "t1", { enabled: true, env: { Y: "1" } }, "env_other");
    await agent("agent_reserved", "t1", { enabled: true, env: { PATH: "/x", EMPTY: "" } });
    await session("sess_plain", "agent_plain", { enabled: true, image: "auto-story-v2" });
    await session("sess_child", "agent_plain", { enabled: true }, null, "sess_plain");
    await session("sess_vars", "agent_vars", { enabled: true, env: { VFS_TOKEN: "agent-vfs" } });
    await session("sess_off", "agent_off", { enabled: false });
    await session("sess_gone", "agent_deleted", { enabled: true, env: { Z: "1" } });
    await session("sess_gone_off", "agent_deleted_off", { enabled: false });
    await session("sess_bound", "agent_bound", { enabled: true }, "env_other");
    await session("sess_unset", "agent_bare", undefined);
  });
  afterAll(async () => { await harness?.close(); });

  it("fails and changes nothing without a built video-production", async () => {
    /** The migration on a client of its own, rolled back after it fails. */
    const failing = async () => {
      const client = await harness.pool.connect();
      try {
        const sql = (await migration("0029_environment_migration.sql")).replaceAll("oma.", `${harness.schema}.`);
        await expect(client.query(sql)).rejects.toThrow(/env_video_production does not exist or serves no image/);
        await client.query("ROLLBACK");
      } finally { client.release(); }
    };
    const before = await state();
    await failing();
    expect(await state()).toEqual(before);
    await builtIn(null);
    const unbuilt = await state();
    await failing();
    expect(await state()).toEqual(unbuilt);
  });

  it("binds every Sandboxed Agent, copies video-production with an Agent's variables, freezes Sessions and strips image and env", async () => {
    await builtIn();
    await apply("0029_environment_migration.sql");
    const after = await state();
    expect(Object.fromEntries(after.agents.map((row) => [row.id, [row.sandbox, row.environment_id]]))).toEqual({
      agent_bare: [null, "env_video_production"],
      agent_bound: [{ enabled: true }, "env_other"],
      agent_off: [{ enabled: false }, null],
      agent_plain: [{ enabled: true }, "env_video_production"],
      // Every name it set is reserved or empty: nothing to copy.
      agent_reserved: [{ enabled: true }, "env_video_production"],
      agent_vars: [{ enabled: true }, "env_agent_vars"],
    });
    expect(Object.fromEntries(after.sessions.map((row) => [row.id, [row.sandbox, row.environment_id]]))).toEqual({
      sess_bound: [{ enabled: true }, "env_other"],
      sess_child: [{ enabled: true }, "env_video_production"],
      sess_gone: [{ enabled: true }, "env_video_production"],
      sess_gone_off: [{ enabled: false }, null],
      sess_off: [{ enabled: false }, null],
      sess_plain: [{ enabled: true }, "env_video_production"],
      sess_unset: [null, "env_video_production"],
      sess_vars: [{ enabled: true }, "env_agent_vars"],
    });
    expect(after.environments.find((row) => row.id === "env_agent_vars")).toEqual({
      id: "env_agent_vars", tenant_id: "t1", name: "video-production-agent_vars", status: "pending", image: IMAGE, last_build_id: "envb_agent_vars",
      env: [
        { name: "HTTP_PROXY", value: "http://agent-proxy" },
        { name: "VFS_TOKEN", value: "agent-vfs" },
        { name: "GOOGLE_API_KEY", secretRef: { source: "platform", key: "GOOGLE_API_KEY" } },
        { name: "OWN", value: "1" },
      ],
    });
    expect(after.builds).toEqual([
      { id: "envb_agent_vars", environment_id: "env_agent_vars", status: "pending", definition_sha256: "sha-video" },
      { id: "envb_video", environment_id: "env_video_production", status: "succeeded", definition_sha256: "sha-video" },
    ]);
    // The stores read the result: the copy serves video-production's image until its own build.
    const { agentStore, environmentStore, sessionStore } = await createPgStores(harness.pool, { ensureSchema: false });
    expect(await agentStore.getById("agent_vars")).toMatchObject({ sandbox: { enabled: true }, environmentId: "env_agent_vars" });
    expect((await sessionStore.getById("sess_vars"))?.agent.sandbox).toEqual({ enabled: true });
    expect(await environmentStore.get("t1", "env_agent_vars")).toMatchObject({ ownerType: "tenant", status: "pending", baseImage: "oma-media",
      initScript: "apt-get install -y libgl1\n", manifest: { dpkg: { ffmpeg: "9" } }, lastBuild: { id: "envb_agent_vars", status: "pending" } });
    expect(await environmentStore.getForSandbox("t1", "env_agent_vars")).toMatchObject({ image: IMAGE, encryptedSecrets: {} });
    expect((await environmentStore.list("t2")).map((env) => env.id)).toEqual(["env_video_production"]);

    // Applied again, it changes nothing.
    await apply("0029_environment_migration.sql");
    expect(await state()).toEqual(after);
  });

  it("counts what it will change before, and what it did after (deploy/scripts/environment-migration-counts.sql)", async () => {
    await builtIn();
    const counts = async () => {
      const sql = (await readFile(new URL("../../../../deploy/scripts/environment-migration-counts.sql", import.meta.url), "utf8")).replaceAll("oma.", `${harness.schema}.`);
      const results = await harness.pool.query(sql) as unknown as Array<{ rows: Record<string, unknown>[] }>;
      return { checks: Object.fromEntries(results[0]!.rows.map((row) => [row.check, Number(row.n)])), dropped: results[2]!.rows };
    };
    const before = await counts();
    expect(before.checks).toMatchObject({
      "video-production ready": 1, "Sandboxed Agents": 5, "Sandboxed Agents without an Environment (to bind)": 4,
      "of them with sandbox.env (a copy each, unless every name is dropped)": 2, "Agents with sandbox.image or sandbox.env (to strip)": 5,
      "Session snapshots with sandbox.image or sandbox.env (to strip)": 3, "Tenant copies made by 0029": 0,
    });
    expect(before.dropped).toEqual([
      { agent_id: "agent_reserved", dropped_name: "EMPTY", why: "empty" }, { agent_id: "agent_reserved", dropped_name: "PATH", why: "reserved" },
      { agent_id: "agent_vars", dropped_name: "EMPTY", why: "empty" }, { agent_id: "agent_vars", dropped_name: "HOME", why: "reserved" },
      { agent_id: "agent_vars", dropped_name: "OMA_X", why: "reserved" },
    ]);
    await apply("0029_environment_migration.sql");
    expect((await counts()).checks).toMatchObject({
      "Sandboxed Agents without an Environment (to bind)": 0, "Agents with sandbox.image or sandbox.env (to strip)": 0,
      "Session snapshots with sandbox.image or sandbox.env (to strip)": 0, "Tenant copies made by 0029": 1,
    });
  });

  it("rolls back to the state before it, keeping what was created since, and migrates again to the same result", async () => {
    await builtIn();
    const before = await state();
    await apply("0029_environment_migration.sql");
    const migrated = await state();
    // Created by the new API after the migration: bound, and kept by the rollback.
    await agent("agent_new", "t1", { enabled: true }, "env_video_production");
    await session("sess_new", "agent_new", { enabled: true }, "env_video_production");
    await apply("0029_environment_migration.rollback.sql");
    const rolledBack = await state();
    expect({ ...rolledBack, agents: rolledBack.agents.filter((row) => row.id !== "agent_new"), sessions: rolledBack.sessions.filter((row) => row.id !== "sess_new") })
      .toEqual(before);
    expect(rolledBack.agents.find((row) => row.id === "agent_new")).toMatchObject({ environment_id: "env_video_production" });
    expect(await query("SELECT to_regclass('migration_0029_agents') AS t")).toEqual([{ t: null }]);
    await harness.pool.query("DELETE FROM sessions WHERE id = 'sess_new'; DELETE FROM agents WHERE id = 'agent_new'");
    await apply("0029_environment_migration.sql");
    expect(await state()).toEqual(migrated);
  });

  it("keeps on rollback a copy a Session created since references, with its build, and deletes the others", async () => {
    await builtIn();
    await agent("agent_more", "t1", { enabled: true, env: { MORE: "1" } });
    await apply("0029_environment_migration.sql");
    // The new API ran a Session in the copy of agent_vars, then the rollback.
    await session("sess_after", "agent_vars", { enabled: true }, "env_agent_vars");
    await apply("0029_environment_migration.rollback.sql");
    const rolledBack = await state();
    expect(rolledBack.environments.map((row) => row.id)).toEqual(["env_agent_vars", "env_video_production"]);
    expect(rolledBack.builds.map((row) => row.id)).toEqual(["envb_agent_vars", "envb_video"]);
    expect(rolledBack.sessions.find((row) => row.id === "sess_after")).toMatchObject({ environment_id: "env_agent_vars" });
    // The Agent itself is back as it was.
    expect(rolledBack.agents.find((row) => row.id === "agent_vars")).toMatchObject({ environment_id: null, sandbox: { image: "custom:1" } });
  });
});
