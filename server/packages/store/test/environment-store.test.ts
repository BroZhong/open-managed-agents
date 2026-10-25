import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PgEnvironmentStore } from "../src/postgres/environment-store.js";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";
import { environmentStoreContract } from "./environment-store-contract.js";

let harness: PgTestHarness;
beforeAll(async () => { harness = await createPgTestHarness(); });

environmentStoreContract("PgEnvironmentStore", async () => {
  await harness.reset();
  return new PgEnvironmentStore(harness.pool);
}, async () => { await harness.close(); });

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
