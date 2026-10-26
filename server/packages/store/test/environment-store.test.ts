import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { PgEnvironmentStore } from "../src/postgres/environment-store.js";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";
import { environmentStoreContract } from "./environment-store-contract.js";
import { environmentBuildQueueContract } from "./environment-build-queue-contract.js";

let harness: PgTestHarness;
beforeAll(async () => { harness = await createPgTestHarness(); });

environmentStoreContract("PgEnvironmentStore", async () => {
  await harness.reset();
  return new PgEnvironmentStore(harness.pool);
}, async () => { await harness.close(); });

let queueHarness: PgTestHarness;
environmentBuildQueueContract("PgEnvironmentStore build queue", async () => {
  // pg-mem ignores SKIP LOCKED; the concurrent claim below needs real PostgreSQL.
  queueHarness ??= await createPgTestHarness({ allowUnsupportedLockSyntax: true });
  await queueHarness.reset();
  return {
    store: new PgEnvironmentStore(queueHarness.pool),
    expireLeases: async () => {
      await queueHarness.pool.query(`UPDATE environment_builds SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE status = 'running'`);
    },
  };
}, async () => { await queueHarness?.close(); });

describe.skipIf(!process.env.PG_TEST_URL)("PgEnvironmentStore claims concurrently", () => {
  let pg: PgTestHarness;
  beforeAll(async () => { pg = await createPgTestHarness(); });
  afterAll(async () => { await pg.close(); });

  it("gives concurrent builders distinct builds, skipping rows another is claiming", async () => {
    const store = new PgEnvironmentStore(pg.pool);
    for (let i = 0; i < 6; i++) {
      await store.create({ id: `env_c${i}`, owner: { ownerType: "tenant", tenantId: "t1" }, name: `c${i}`, description: "", baseImage: "oma-base", initScript: "", env: [], encryptedSecrets: {} });
    }
    const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => store.claimBuild(`builder-${i}`, 60_000)));
    const claimed = claims.filter((claim) => claim !== null).map((claim) => claim!.build.environmentId);
    expect(new Set(claimed).size).toBe(claimed.length);
    // SKIP LOCKED may pass over a row being claimed; a second round takes whatever is left.
    while (await store.claimBuild("builder-late", 60_000)) claimed.push("late");
    expect(claimed).toHaveLength(6);
  });
});

describe.skipIf(!process.env.PG_TEST_URL)("PgEnvironmentStore locks an Environment before its build", () => {
  // Every change to an Environment locks it, then supersedes its build; a
  // builder taking the two locks the other way round deadlocks with it.
  let pg: PgTestHarness;
  let store: PgEnvironmentStore;
  const tenant = { ownerType: "tenant", tenantId: "t1" } as const;
  beforeAll(async () => { pg = await createPgTestHarness(); });
  beforeEach(async () => { await pg.reset(); store = new PgEnvironmentStore(pg.pool); });
  afterAll(async () => { await pg.close(); });

  const created = () => store.create({ id: "env_lock", owner: tenant, name: "lock", description: "", baseImage: "oma-base", initScript: "true\n", env: [], encryptedSecrets: {} });

  /** A store whose next transaction stops once it has locked the Environment, until released. */
  function editing() {
    let held!: (pid: number) => void;
    let release!: () => void;
    const locked = new Promise<number>((resolve) => { held = resolve; });
    const resumed = new Promise<void>((resolve) => { release = resolve; });
    const pool = new Proxy(pg.pool, {
      get(target, prop) {
        if (prop !== "connect") return Reflect.get(target, prop, target);
        return async () => {
          const client = await target.connect();
          const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
          (client as { query: unknown }).query = async (...args: unknown[]) => {
            const result = await query(...args);
            if (typeof args[0] === "string" && /FROM environments WHERE id = \$1 .*FOR UPDATE/s.test(args[0])) {
              (client as { query: unknown }).query = query;
              held((await query("SELECT pg_backend_pid() AS pid") as { rows: [{ pid: number }] }).rows[0].pid);
              await resumed;
            }
            return result;
          };
          return client;
        };
      },
    });
    return { store: new PgEnvironmentStore(pool), locked, release };
  }

  /**
   * Whether a transaction comes to wait for the lock the backend `pid`
   * holds, watched until it does or `settled` says it never will.
   */
  async function blockedBy(pid: number, settled: () => boolean = () => false): Promise<boolean> {
    while (!settled()) {
      const { rows } = await pg.pool.query(`SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`, [pid]);
      if (rows.length) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  }

  it("passes over an Environment being edited rather than wait to claim the build the edit supersedes", async () => {
    const env = await created();
    const edit = editing();
    onTestFinished(() => edit.release());
    const changed = edit.store.update(tenant, env.id, { initScript: "echo v2\n" });
    const pid = await edit.locked;
    let settled = false;
    const claim = store.claimBuild("builder-1", 60_000).finally(() => { settled = true; });
    expect(await blockedBy(pid, () => settled)).toBe(false);
    expect(await claim).toBeNull();
    edit.release();
    expect(await changed).toMatchObject({ initScript: "echo v2\n", status: "pending" });
    expect((await store.claimBuild("builder-1", 60_000))?.build.initScript).toBe("echo v2\n");
  });

  it("finishes a build after an edit of its Environment, which supersedes it", async () => {
    const env = await created();
    const claimed = (await store.claimBuild("builder-1", 60_000))!;
    const edit = editing();
    onTestFinished(() => edit.release());
    const changed = edit.store.update(tenant, env.id, { initScript: "echo v2\n" });
    const pid = await edit.locked;
    const finished = store.succeedBuild(claimed.lease, { image: "registry/env@sha256:new", manifest: {} });
    // The builder waits for the edit's lock, holding nothing the edit needs.
    expect(await blockedBy(pid)).toBe(true);
    edit.release();
    expect(await changed).toMatchObject({ status: "pending", image: null });
    expect(await finished).toBe(false);
    expect((await store.listBuilds(env.id)).map((build) => build.status)).toEqual(["pending", "superseded"]);
  });

  it("serializes edits worked out under the lock: each sees what the one before it wrote", async () => {
    const env = await created();
    const append = (name: string) => store.update(tenant, env.id, (current) => ({ env: [...current.env, { name, value: "1" }] }));
    await Promise.all(["A", "B", "C", "D"].map(append));
    expect((await store.get("t1", env.id))!.env.map((variable) => variable.name).sort()).toEqual(["A", "B", "C", "D"]);
  });
});

describe("PgEnvironmentStore builds as the builder leaves them", () => {
  let pg: PgTestHarness;
  let store: PgEnvironmentStore;
  const tenant = { ownerType: "tenant", tenantId: "t1" } as const;
  beforeAll(async () => { pg = await createPgTestHarness(); });
  beforeEach(async () => { await pg.reset(); store = new PgEnvironmentStore(pg.pool); });
  afterAll(async () => { await pg.close(); });

  it("supersedes a running build and shows the builder's outcome on the Environment", async () => {
    const env = await store.create({ id: "env_a", owner: tenant, name: "a", description: "", baseImage: "oma-base", initScript: "true\n", env: [], encryptedSecrets: {} });
    const [build] = await store.listBuilds(env.id);
    // A builder holds the lease while the Environment is building.
    await pg.pool.query(
      `UPDATE environment_builds SET status = 'running', attempts = 1, lease_owner = 'builder-1',
         lease_expires_at = $2, started_at = $3, base_image_digest = 'sha256:base' WHERE id = $1`,
      [build.id, new Date("2026-10-26T01:05:00Z"), new Date("2026-10-26T01:00:00Z")],
    );
    await pg.pool.query(`UPDATE environments SET status = 'building', image = 'registry/env@sha256:old', manifest = $2::jsonb WHERE id = $1`,
      [env.id, JSON.stringify({ dpkg: { jq: "1.6" } })]);
    expect(await store.get("t1", env.id)).toMatchObject({
      status: "building", image: "registry/env@sha256:old", manifest: { dpkg: { jq: "1.6" } },
      lastBuild: { id: build.id, status: "running", startedAt: new Date("2026-10-26T01:00:00Z") },
    });
    expect((await store.listBuilds(env.id))[0]).toMatchObject({ attempts: 1, leaseOwner: "builder-1", leaseExpiresAt: new Date("2026-10-26T01:05:00Z"), baseImageDigest: "sha256:base" });

    const changed = await store.update(tenant, env.id, { initScript: "false\n" });
    // The serving image stays until a newer build succeeds.
    expect(changed).toMatchObject({ status: "pending", image: "registry/env@sha256:old" });
    const builds = await store.listBuilds(env.id);
    expect(builds.map((b) => b.status)).toEqual(["pending", "superseded"]);
    expect(builds[1]).toMatchObject({ id: build.id, leaseOwner: "builder-1", finishedAt: expect.any(Date) });
  });

  it("allows only one active build per Environment", async () => {
    const env = await store.create({ id: "env_b", owner: tenant, name: "b", description: "", baseImage: "oma-base", initScript: "", env: [], encryptedSecrets: {} });
    await expect(pg.pool.query(
      `INSERT INTO environment_builds (id, environment_id, owner_type, tenant_id, status, base_image, init_script, definition_sha256, created_at)
       VALUES ('envb_dup', $1, 'tenant', 't1', 'running', 'oma-base', '', 'x', now())`, [env.id],
    )).rejects.toMatchObject({ code: "23505" });
  });
});
