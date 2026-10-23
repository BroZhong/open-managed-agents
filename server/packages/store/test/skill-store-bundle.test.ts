import { afterAll, beforeAll, expect, it } from "vitest";
import { PgSkillStore } from "../src/postgres/skill-store.js";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";
import { skillStoreBundleContract } from "./skill-store-bundle-contract.js";

let harness: PgTestHarness;
beforeAll(async () => { harness = await createPgTestHarness(); });

skillStoreBundleContract("PgSkillStore Skill Bundle columns", async () => {
  await harness.reset();
  return new PgSkillStore(harness.pool);
}, async () => { await harness.close(); });

it("reads Skills written before the bundle migration as having no bundle", async () => {
  const pg = await createPgTestHarness();
  try {
    await pg.pool.query(
      `INSERT INTO skills (skill_id, tenant_id, name, description, owner_type, owner_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ["skill_legacy", "t1", "Legacy", "d", "library", "t1", new Date("2026-01-01T00:00:00Z")],
    );
    const store = new PgSkillStore(pg.pool);
    expect(await store.getById("skill_legacy")).toMatchObject({ bundleSha256: null, bundleSize: null });
    expect(await store.update("skill_legacy", { bundleSha256: "a".repeat(64), bundleSize: 52_428_800 }, { expectedBundleSha256: null }))
      .toMatchObject({ bundleSha256: "a".repeat(64), bundleSize: 52_428_800 });
  } finally {
    await pg.close();
  }
});
