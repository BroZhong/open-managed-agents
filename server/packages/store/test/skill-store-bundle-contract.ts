import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { SkillVersionConflictError, type SkillStore } from "../src/index.js";

const V1 = "1".repeat(64);
const V2 = "2".repeat(64);
const V3 = "3".repeat(64);

/** Skill Bundle columns and version compare-and-set, shared by every {@link SkillStore}. */
export function skillStoreBundleContract(name: string, create: () => Promise<SkillStore>, close?: () => Promise<void>) {
  describe(name, () => {
    let store: SkillStore;
    beforeEach(async () => { store = await create(); });
    afterAll(async () => { await close?.(); });

    it("records no bundle until one is set, and reads a set bundle back from every query", async () => {
      const legacy = await store.create({ tenantId: "t1", name: "legacy", description: "" });
      expect(legacy).toMatchObject({ bundleSha256: null, bundleSize: null });
      const packed = await store.create({ tenantId: "t1", name: "packed", description: "", bundleSha256: V1, bundleSize: 1234 });
      expect(packed).toMatchObject({ bundleSha256: V1, bundleSize: 1234 });
      const fork = await store.create({ tenantId: "t1", name: "packed", description: "", ownerType: "agent", ownerId: "a1", sourceSkillId: packed.id, bundleSha256: V1, bundleSize: 1234 });
      expect(await store.getById(packed.id)).toMatchObject({ bundleSha256: V1, bundleSize: 1234 });
      expect((await store.list("t1")).data.map((skill) => [skill.name, skill.bundleSha256, skill.bundleSize]))
        .toEqual(expect.arrayContaining([["legacy", null, null], ["packed", V1, 1234]]));
      expect(await store.listByOwner("t1", "agent", "a1")).toEqual([expect.objectContaining({ id: fork.id, bundleSha256: V1, bundleSize: 1234 })]);
      expect(typeof (await store.getById(packed.id))?.bundleSize).toBe("number");
    });

    it("sets, keeps and clears the bundle on unconditional updates", async () => {
      const skill = await store.create({ tenantId: "t1", name: "s", description: "" });
      expect(await store.update(skill.id, { bundleSha256: V1, bundleSize: 10 })).toMatchObject({ bundleSha256: V1, bundleSize: 10 });
      expect(await store.update(skill.id, { description: "edited" })).toMatchObject({ description: "edited", bundleSha256: V1, bundleSize: 10 });
      expect(await store.update(skill.id, { bundleSha256: null, bundleSize: null })).toMatchObject({ bundleSha256: null, bundleSize: null });
    });

    it("requires bundleSha256 and bundleSize together, as a valid digest and size", async () => {
      const skill = await store.create({ tenantId: "t1", name: "s", description: "" });
      await expect(store.update(skill.id, { bundleSha256: V1 })).rejects.toThrow("bundleSha256 and bundleSize must be set together");
      await expect(store.update(skill.id, { bundleSha256: V1, bundleSize: null })).rejects.toThrow("bundleSha256 and bundleSize must be set together");
      await expect(store.update(skill.id, { bundleSha256: "not-a-digest", bundleSize: 1 })).rejects.toThrow("bundleSha256 and bundleSize must be set together");
      await expect(store.create({ tenantId: "t1", name: "x", description: "", bundleSize: 1 })).rejects.toThrow("bundleSha256 and bundleSize must be set together");
      expect(await store.getById(skill.id)).toMatchObject({ bundleSha256: null, bundleSize: null });
    });

    it("applies a version update only when the current bundle is the expected one", async () => {
      const skill = await store.create({ tenantId: "t1", name: "s", description: "v0" });
      const first = await store.update(skill.id, { bundleSha256: V1, bundleSize: 1, description: "v1" }, { expectedBundleSha256: null });
      expect(first).toMatchObject({ bundleSha256: V1, description: "v1" });
      const second = await store.update(skill.id, { bundleSha256: V2, bundleSize: 2, description: "v2" }, { expectedBundleSha256: V1 });
      expect(second).toMatchObject({ bundleSha256: V2, bundleSize: 2, description: "v2" });
      const before = structuredClone(await store.getById(skill.id));

      const stale = await store.update(skill.id, { bundleSha256: V3, bundleSize: 3, name: "renamed" }, { expectedBundleSha256: V1 })
        .catch((error: unknown) => error);
      expect(stale).toBeInstanceOf(SkillVersionConflictError);
      expect(stale).toMatchObject({ code: "skill_version_conflict", skillId: skill.id, expectedBundleSha256: V1, actualBundleSha256: V2 });
      await expect(store.update(skill.id, { description: "x" }, { expectedBundleSha256: null })).rejects.toBeInstanceOf(SkillVersionConflictError);
      expect(await store.getById(skill.id)).toEqual(before);
    });

    it("lets exactly one of two edits based on the same version win", async () => {
      const skill = await store.create({ tenantId: "t1", name: "s", description: "", bundleSha256: V1, bundleSize: 1 });
      const results = await Promise.allSettled([
        store.update(skill.id, { bundleSha256: V2, bundleSize: 2 }, { expectedBundleSha256: V1 }),
        store.update(skill.id, { bundleSha256: V3, bundleSize: 3 }, { expectedBundleSha256: V1 }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(SkillVersionConflictError);
    });

    it("reports a missing Skill as null, not as a conflict", async () => {
      expect(await store.update("skill_missing", { bundleSha256: V1, bundleSize: 1 }, { expectedBundleSha256: null })).toBeNull();
      expect(await store.update("skill_missing", { description: "x" })).toBeNull();
    });
  });
}
