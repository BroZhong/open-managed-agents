import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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
