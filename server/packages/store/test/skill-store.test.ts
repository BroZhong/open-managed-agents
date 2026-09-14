import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { PgSkillStore } from "../src/postgres/skill-store.js";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";

describe("PgSkillStore (ADR-0004 owner columns)", () => {
  let harness: PgTestHarness;
  let store: PgSkillStore;

  beforeAll(async () => {
    harness = await createPgTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
    store = new PgSkillStore(harness.pool);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves the upload time while metadata and file edits advance updatedAt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const uploadedAt = new Date("2026-09-08T01:00:00.000Z");
    vi.setSystemTime(uploadedAt);
    const skill = await store.create({ tenantId: "t1", name: "S", description: "d" });
    expect(skill.createdAt).toEqual(uploadedAt);
    expect(skill.updatedAt).toEqual(uploadedAt);

    const editedAt = new Date("2026-09-08T02:00:00.000Z");
    vi.setSystemTime(editedAt);
    await store.update(skill.id, { description: "Edited" });
    const listed = (await store.list("t1")).data[0];
    expect(listed.createdAt).toEqual(uploadedAt);
    expect(listed.updatedAt).toEqual(editedAt);

    const fileEditedAt = new Date("2026-09-08T03:00:00.000Z");
    vi.setSystemTime(fileEditedAt);
    await store.update(skill.id, {});
    expect(await store.getById(skill.id)).toMatchObject({
      description: "Edited",
      createdAt: uploadedAt,
      updatedAt: fileEditedAt,
    });
  });

  it("keeps unknown legacy creation times null across reads and edits", async () => {
    await harness.pool.query(
      `INSERT INTO skills (skill_id, tenant_id, name, description, owner_type, owner_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ["skill_legacy", "t1", "Legacy", "d", "library", "t1", new Date("2026-01-01T00:00:00Z")],
    );
    expect((await store.getById("skill_legacy"))?.createdAt).toBeNull();
    const updated = await store.update("skill_legacy", { description: "Edited" });
    expect(updated?.createdAt).toBeNull();
    expect((await store.list("t1")).data[0].createdAt).toBeNull();
  });

  it("defaults create() to a Library Skill owned by the tenant", async () => {
    const skill = await store.create({ tenantId: "t1", name: "S", description: "d" });
    expect(skill.id).toMatch(/^skill_/);
    expect(skill.ownerType).toBe("library");
    expect(skill.ownerId).toBe("t1");
    expect(skill.sourceSkillId).toBeNull();
  });

  it("creates an Agent Skill (fork) carrying source_skill_id", async () => {
    const lib = await store.create({ tenantId: "t1", name: "S", description: "d" });
    const fork = await store.create({
      tenantId: "t1",
      name: "S",
      description: "d",
      ownerType: "agent",
      ownerId: "agent_1",
      sourceSkillId: lib.id,
    });
    expect(fork.ownerType).toBe("agent");
    expect(fork.ownerId).toBe("agent_1");
    expect(fork.sourceSkillId).toBe(lib.id);
    expect(fork.id).not.toBe(lib.id);
  });

  it("list() returns only Library Skills, never forks", async () => {
    const lib = await store.create({ tenantId: "t1", name: "L", description: "d" });
    await store.create({
      tenantId: "t1",
      name: "F",
      description: "d",
      ownerType: "agent",
      ownerId: "agent_1",
      sourceSkillId: lib.id,
    });
    const { data } = await store.list("t1");
    expect(data.map((s) => s.id)).toEqual([lib.id]);
  });

  it("listByOwner() returns an Agent's forks", async () => {
    const lib = await store.create({ tenantId: "t1", name: "L", description: "d" });
    const fork = await store.create({
      tenantId: "t1",
      name: "F",
      description: "d",
      ownerType: "agent",
      ownerId: "agent_1",
      sourceSkillId: lib.id,
    });
    // A different agent's fork must not leak in.
    await store.create({
      tenantId: "t1",
      name: "F2",
      description: "d",
      ownerType: "agent",
      ownerId: "agent_2",
      sourceSkillId: lib.id,
    });
    const forks = await store.listByOwner("t1", "agent", "agent_1");
    expect(forks.map((s) => s.id)).toEqual([fork.id]);
  });

  it("deleting a Library Skill leaves its forks intact", async () => {
    const lib = await store.create({ tenantId: "t1", name: "L", description: "d" });
    const fork = await store.create({
      tenantId: "t1",
      name: "F",
      description: "d",
      ownerType: "agent",
      ownerId: "agent_1",
      sourceSkillId: lib.id,
    });
    await store.delete(lib.id);
    expect(await store.getById(lib.id)).toBeNull();
    const stillThere = await store.getById(fork.id);
    expect(stillThere?.id).toBe(fork.id);
    expect(stillThere?.sourceSkillId).toBe(lib.id);
  });

  it("tenants are isolated in listByOwner", async () => {
    await store.create({
      tenantId: "t1",
      name: "F",
      description: "d",
      ownerType: "agent",
      ownerId: "agent_1",
    });
    const other = await store.listByOwner("t2", "agent", "agent_1");
    expect(other).toHaveLength(0);
  });
});
