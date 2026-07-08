import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PgSessionStore } from "../src/postgres/session-store.js";
import { PgWorkspaceMetadataStore } from "../src/postgres/workspace-metadata-store.js";
import type { Agent } from "../src/types.js";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";

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

describe("PgSessionStore", () => {
  let harness: PgTestHarness;
  let store: PgSessionStore;
  let workspaces: PgWorkspaceMetadataStore;

  beforeAll(async () => {
    harness = await createPgTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
    store = new PgSessionStore(harness.pool);
    workspaces = new PgWorkspaceMetadataStore(harness.pool);
  });

  async function newWorkspace(tenantId = "tenant1"): Promise<string> {
    const ws = await workspaces.create({ tenantId });
    return ws.id;
  }

  it("should create a session with sess_ prefix and idle status", async () => {
    const workspaceId = await newWorkspace();
    const session = await store.create({
      tenantId: "tenant1",
      agentId: mockAgent.id,
      agent: mockAgent,
      workspaceId,
    });

    expect(session.id).toMatch(/^sess_/);
    expect(session.tenantId).toBe("tenant1");
    expect(session.agentId).toBe(mockAgent.id);
    expect(session.status).toBe("idle");
    expect(session.agent).toEqual(mockAgent);
    expect(session.workspaceId).toBe(workspaceId);
    expect(session.createdAt).toBeInstanceOf(Date);
    expect(session.terminatedAt).toBeUndefined();
  });

  it("should get a session by id", async () => {
    const workspaceId = await newWorkspace();
    const created = await store.create({
      tenantId: "tenant1",
      agentId: mockAgent.id,
      agent: mockAgent,
      workspaceId,
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
    const workspaceId = await newWorkspace();
    const created = await store.create({
      tenantId: "tenant1",
      agentId: mockAgent.id,
      agent: mockAgent,
      workspaceId,
    });

    const updated = await store.updateStatus(created.id, "running");
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("running");
  });

  it("should terminate a session", async () => {
    const workspaceId = await newWorkspace();
    const created = await store.create({
      tenantId: "tenant1",
      agentId: mockAgent.id,
      agent: mockAgent,
      workspaceId,
    });

    const terminated = await store.terminate(created.id);
    expect(terminated).not.toBeNull();
    expect(terminated!.status).toBe("terminated");
    expect(terminated!.terminatedAt).toBeInstanceOf(Date);
  });

  it("should list sessions with filtering by status", async () => {
    const workspaceId = await newWorkspace();
    await store.create({ tenantId: "tenant1", agentId: mockAgent.id, agent: mockAgent, workspaceId });
    const sess2 = await store.create({ tenantId: "tenant1", agentId: mockAgent.id, agent: mockAgent, workspaceId });
    await store.updateStatus(sess2.id, "running");

    const running = await store.list("tenant1", { status: "running" });
    expect(running.data).toHaveLength(1);
    expect(running.data[0].status).toBe("running");

    const idle = await store.list("tenant1", { status: "idle" });
    expect(idle.data).toHaveLength(1);
    expect(idle.data[0].status).toBe("idle");
  });

  it("should list sessions with filtering by agentId", async () => {
    const workspaceId = await newWorkspace();
    await store.create({ tenantId: "tenant1", agentId: "agent_a", agent: { ...mockAgent, id: "agent_a" }, workspaceId });
    await store.create({ tenantId: "tenant1", agentId: "agent_b", agent: { ...mockAgent, id: "agent_b" }, workspaceId });

    const result = await store.list("tenant1", { agentId: "agent_a" });
    expect(result.data).toHaveLength(1);
    expect(result.data[0].agentId).toBe("agent_a");
  });

  it("should list sessions with pagination", async () => {
    const workspaceId = await newWorkspace();
    for (let i = 0; i < 5; i++) {
      await store.create({ tenantId: "tenant1", agentId: mockAgent.id, agent: mockAgent, workspaceId });
    }

    const page1 = await store.list("tenant1", { limit: 3 });
    expect(page1.data).toHaveLength(3);
    expect(page1.hasMore).toBe(true);

    const page2 = await store.list("tenant1", { limit: 3, cursor: page1.data[2].id });
    expect(page2.data).toHaveLength(2);
    expect(page2.hasMore).toBe(false);
  });

  it("should isolate sessions by tenant", async () => {
    const ws1 = await newWorkspace("tenant1");
    const ws2 = await newWorkspace("tenant2");
    await store.create({ tenantId: "tenant1", agentId: mockAgent.id, agent: mockAgent, workspaceId: ws1 });
    await store.create({ tenantId: "tenant2", agentId: mockAgent.id, agent: mockAgent, workspaceId: ws2 });

    const t1 = await store.list("tenant1");
    expect(t1.data).toHaveLength(1);

    const t2 = await store.list("tenant2");
    expect(t2.data).toHaveLength(1);
  });
});
