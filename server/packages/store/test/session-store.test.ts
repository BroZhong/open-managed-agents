import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { MongoSessionStore } from "../src/mongodb/session-store.js";
import type { Agent } from "../src/types.js";

const mockAgent: Agent = {
  id: "agent_test123",
  tenantId: "tenant1",
  name: "Test Agent",
  model: "claude-3",
  system: "You are helpful",
  runtime: "claude-code",
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};

describe("MongoSessionStore", () => {
  let mongod: MongoMemoryServer;
  let client: MongoClient;
  let store: MongoSessionStore;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    client = new MongoClient(mongod.getUri());
    await client.connect();
  });

  afterAll(async () => {
    await client.close();
    await mongod.stop();
  });

  beforeEach(async () => {
    const db = client.db("test_sessions");
    await db.dropDatabase();
    store = new MongoSessionStore(db);
  });

  it("should create a session with sess_ prefix and idle status", async () => {
    const session = await store.create({
      tenantId: "tenant1",
      agentId: mockAgent.id,
      agent: mockAgent,
    });

    expect(session.id).toMatch(/^sess_/);
    expect(session.tenantId).toBe("tenant1");
    expect(session.agentId).toBe(mockAgent.id);
    expect(session.status).toBe("idle");
    expect(session.agent).toEqual(mockAgent);
    expect(session.createdAt).toBeInstanceOf(Date);
    expect(session.terminatedAt).toBeUndefined();
  });

  it("should get a session by id", async () => {
    const created = await store.create({
      tenantId: "tenant1",
      agentId: mockAgent.id,
      agent: mockAgent,
    });

    const found = await store.getById(created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
  });

  it("should return null for non-existent session", async () => {
    const found = await store.getById("sess_nonexistent");
    expect(found).toBeNull();
  });

  it("should update session status", async () => {
    const created = await store.create({
      tenantId: "tenant1",
      agentId: mockAgent.id,
      agent: mockAgent,
    });

    const updated = await store.updateStatus(created.id, "running");
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("running");
  });

  it("should terminate a session", async () => {
    const created = await store.create({
      tenantId: "tenant1",
      agentId: mockAgent.id,
      agent: mockAgent,
    });

    const terminated = await store.terminate(created.id);
    expect(terminated).not.toBeNull();
    expect(terminated!.status).toBe("terminated");
    expect(terminated!.terminatedAt).toBeInstanceOf(Date);
  });

  it("should list sessions with filtering by status", async () => {
    await store.create({ tenantId: "tenant1", agentId: mockAgent.id, agent: mockAgent });
    const sess2 = await store.create({ tenantId: "tenant1", agentId: mockAgent.id, agent: mockAgent });
    await store.updateStatus(sess2.id, "running");

    const running = await store.list("tenant1", { status: "running" });
    expect(running.data).toHaveLength(1);
    expect(running.data[0].status).toBe("running");

    const idle = await store.list("tenant1", { status: "idle" });
    expect(idle.data).toHaveLength(1);
    expect(idle.data[0].status).toBe("idle");
  });

  it("should list sessions with filtering by agentId", async () => {
    await store.create({ tenantId: "tenant1", agentId: "agent_a", agent: { ...mockAgent, id: "agent_a" } });
    await store.create({ tenantId: "tenant1", agentId: "agent_b", agent: { ...mockAgent, id: "agent_b" } });

    const result = await store.list("tenant1", { agentId: "agent_a" });
    expect(result.data).toHaveLength(1);
    expect(result.data[0].agentId).toBe("agent_a");
  });

  it("should list sessions with pagination", async () => {
    for (let i = 0; i < 5; i++) {
      await store.create({ tenantId: "tenant1", agentId: mockAgent.id, agent: mockAgent });
    }

    const page1 = await store.list("tenant1", { limit: 3 });
    expect(page1.data).toHaveLength(3);
    expect(page1.hasMore).toBe(true);

    const page2 = await store.list("tenant1", { limit: 3, cursor: page1.data[2].id });
    expect(page2.data).toHaveLength(2);
    expect(page2.hasMore).toBe(false);
  });

  it("should isolate sessions by tenant", async () => {
    await store.create({ tenantId: "tenant1", agentId: mockAgent.id, agent: mockAgent });
    await store.create({ tenantId: "tenant2", agentId: mockAgent.id, agent: mockAgent });

    const t1 = await store.list("tenant1");
    expect(t1.data).toHaveLength(1);

    const t2 = await store.list("tenant2");
    expect(t2.data).toHaveLength(1);
  });
});
