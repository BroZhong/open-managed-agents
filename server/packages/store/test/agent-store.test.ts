import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PgAgentStore } from "../src/postgres/agent-store.js";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";

describe("PgAgentStore", () => {
  let harness: PgTestHarness;
  let store: PgAgentStore;

  beforeAll(async () => {
    harness = await createPgTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
    store = new PgAgentStore(harness.pool);
  });

  it("should create an agent with agent_ prefix", async () => {
    const agent = await store.create({
      tenantId: "tenant1",
      name: "Test Agent",
      model: "claude-3",
      system: "You are helpful",
      runtime: "claude-code",
    });

    expect(agent.id).toMatch(/^agent_/);
    expect(agent.tenantId).toBe("tenant1");
    expect(agent.name).toBe("Test Agent");
    expect(agent.model).toBe("claude-3");
    expect(agent.system).toBe("You are helpful");
    expect(agent.runtime).toBe("claude-code");
    expect(agent.createdAt).toBeInstanceOf(Date);
    expect(agent.updatedAt).toBeInstanceOf(Date);
  });

  it("should persist and revive JSON config fields", async () => {
    const agent = await store.create({
      tenantId: "tenant1",
      name: "Configured",
      model: "claude-3",
      system: "sys",
      runtime: "claude-code",
      tools: [{ name: "grep", inputSchema: { type: "object" } }],
      mcpServers: [{ name: "srv", url: "https://example.com" }],
      skills: ["s1", "s2"],
      sandbox: { enabled: true, image: "img" },
    });

    const found = await store.getById(agent.id);
    expect(found!.tools).toEqual([{ name: "grep", inputSchema: { type: "object" } }]);
    expect(found!.mcpServers).toEqual([{ name: "srv", url: "https://example.com" }]);
    expect(found!.skills).toEqual(["s1", "s2"]);
    expect(found!.sandbox).toEqual({ enabled: true, image: "img" });
  });

  it("should get an agent by id", async () => {
    const created = await store.create({
      tenantId: "tenant1",
      name: "Test Agent",
      model: "claude-3",
      system: "You are helpful",
      runtime: "claude-code",
    });

    const found = await store.getById(created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.name).toBe("Test Agent");
  });

  it("should return null for non-existent id", async () => {
    const found = await store.getById("agent_nonexistent");
    expect(found).toBeNull();
  });

  it("should update an agent", async () => {
    const created = await store.create({
      tenantId: "tenant1",
      name: "Test Agent",
      model: "claude-3",
      system: "You are helpful",
      runtime: "claude-code",
    });

    const updated = await store.update(created.id, { name: "Updated Agent", runtime: "codex" });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("Updated Agent");
    expect(updated!.runtime).toBe("codex");
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
  });

  it("should return null when updating non-existent agent", async () => {
    const updated = await store.update("agent_nope", { name: "x" });
    expect(updated).toBeNull();
  });

  it("should delete an agent", async () => {
    const created = await store.create({
      tenantId: "tenant1",
      name: "Test Agent",
      model: "claude-3",
      system: "You are helpful",
      runtime: "claude-code",
    });

    const deleted = await store.delete(created.id);
    expect(deleted).toBe(true);

    const found = await store.getById(created.id);
    expect(found).toBeNull();
  });

  it("should return false when deleting non-existent agent", async () => {
    const deleted = await store.delete("agent_nonexistent");
    expect(deleted).toBe(false);
  });

  it("should list agents with pagination", async () => {
    for (let i = 0; i < 5; i++) {
      await store.create({
        tenantId: "tenant1",
        name: `Agent ${i}`,
        model: "claude-3",
        system: "system",
        runtime: "claude-code",
      });
    }

    const page1 = await store.list("tenant1", { limit: 3 });
    expect(page1.data).toHaveLength(3);
    expect(page1.hasMore).toBe(true);

    const page2 = await store.list("tenant1", { limit: 3, cursor: page1.data[2].id });
    expect(page2.data).toHaveLength(2);
    expect(page2.hasMore).toBe(false);
  });

  it("should isolate agents by tenant", async () => {
    await store.create({
      tenantId: "tenant1",
      name: "Agent A",
      model: "claude-3",
      system: "system",
      runtime: "claude-code",
    });
    await store.create({
      tenantId: "tenant2",
      name: "Agent B",
      model: "claude-3",
      system: "system",
      runtime: "codex",
    });

    const tenant1Agents = await store.list("tenant1");
    expect(tenant1Agents.data).toHaveLength(1);
    expect(tenant1Agents.data[0].name).toBe("Agent A");

    const tenant2Agents = await store.list("tenant2");
    expect(tenant2Agents.data).toHaveLength(1);
    expect(tenant2Agents.data[0].name).toBe("Agent B");
  });
});
