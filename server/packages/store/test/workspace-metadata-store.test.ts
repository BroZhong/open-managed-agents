import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PgWorkspaceMetadataStore } from "../src/postgres/workspace-metadata-store.js";
import { PgSessionStore } from "../src/postgres/session-store.js";
import type { Agent } from "../src/types.js";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";

const mockAgent: Agent = {
  id: "agent_ws",
  tenantId: "tenant1",
  name: "Test Agent",
  model: "claude-3",
  system: "You are helpful",
  runtime: "mock",
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};

describe("PgWorkspaceMetadataStore", () => {
  let harness: PgTestHarness;
  let store: PgWorkspaceMetadataStore;

  beforeAll(async () => {
    harness = await createPgTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
    store = new PgWorkspaceMetadataStore(harness.pool);
  });

  it("persists soft deletion while retaining records and filtering before Session pagination", async () => {
    const hidden = await store.create({ tenantId: "tenant1", name: "Hidden" });
    const visible = await store.create({ tenantId: "tenant1", name: "Visible" });
    const sessions = new PgSessionStore(harness.pool);
    const removed = await sessions.create({ tenantId: "tenant1", agentId: mockAgent.id, agent: mockAgent, workspaceId: visible.id });
    await sessions.updateStatus(removed.id, "running");
    await sessions.softDelete(removed.id);
    await sessions.create({ tenantId: "tenant1", agentId: mockAgent.id, agent: mockAgent, workspaceId: hidden.id });
    const kept = await sessions.create({ tenantId: "tenant1", agentId: mockAgent.id, agent: mockAgent, workspaceId: visible.id });
    await store.softDelete("tenant1", hidden.id);
    expect((await store.list("tenant1")).map((w) => w.id)).toEqual([visible.id]);
    expect(await store.list("tenant1", true)).toHaveLength(2);
    expect(await store.getById("tenant1", hidden.id)).toMatchObject({ deletedAt: expect.any(Date) });
    expect(await sessions.getById(removed.id)).toMatchObject({ deletedAt: expect.any(Date), status: "running" });
    const result = await sessions.list("tenant1", { limit: 1, excludedWorkspaceIds: [hidden.id] });
    expect(result.data.map((s) => s.id)).toEqual([kept.id]);
    expect(result.hasMore).toBe(false);
    expect(await store.softDelete("other", hidden.id)).toBeNull();
  });

  it("paginates Agent Workspace summaries after filtering and aggregates activity beyond the latest Session", async () => {
    const sessions = new PgSessionStore(harness.pool);
    const create = async (id: string, date: string, extra = {}) => {
      await store.create({ tenantId: "tenant1", id, name: id });
      const session = await sessions.create({ tenantId: "tenant1", agentId: mockAgent.id, agent: mockAgent, workspaceId: id, ...extra });
      await harness.pool.query("UPDATE sessions SET updated_at = $2 WHERE id = $1", [session.id, date]);
      return session;
    };
    const active = await create("a", "2026-11-01T00:00:00Z");
    await sessions.updateStatus(active.id, "waiting");
    await harness.pool.query("UPDATE sessions SET updated_at = $2 WHERE id = $1", [active.id, "2026-11-01T00:00:00Z"]);
    await create("a", "2026-11-03T00:00:00Z");
    await create("b", "2026-11-02T00:00:00Z");
    await create("c", "2026-11-02T00:00:00Z");
    await create("loop", "2026-11-04T00:00:00Z", { loopId: "loop" });
    await create("other", "2026-11-04T00:00:00Z", { agentId: "other" });
    await create("child", "2026-11-04T00:00:00Z", { delegation: { parentSessionId: active.id, parentTurnId: "turn", parentToolUseId: "tool", sandboxSessionId: active.id } });
    const removed = await create("deleted_session", "2026-11-04T00:00:00Z");
    await sessions.softDelete(removed.id);
    await create("deleted_workspace", "2026-11-04T00:00:00Z");
    await store.softDelete("tenant1", "deleted_workspace");
    await create("unnamed", "2026-11-04T00:00:00Z");
    await store.update("tenant1", "unnamed", { name: "" });
    await store.create({ tenantId: "tenant2", id: "a", name: "Foreign" });
    const first = await store.listByAgent("tenant1", mockAgent.id, { limit: 2 });
    expect(first.data.map((w) => w.id)).toEqual(["a", "c"]);
    expect(first.data[0]).toMatchObject({ hasRunningSessions: true, updatedAt: new Date("2026-11-03T00:00:00Z") });
    expect(first.data[1].hasRunningSessions).toBe(false);
    expect(first.hasMore).toBe(true);
    await store.softDelete("tenant1", "c");
    const second = await store.listByAgent("tenant1", mockAgent.id, { limit: 2, cursor: first.nextCursor });
    expect(second.data.map((w) => w.id)).toEqual(["b"]);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeUndefined();
    expect((await store.listByAgent("tenant2", mockAgent.id, { limit: 5 })).data).toEqual([]);
  });

  it("auto-creates a Workspace with ws_ prefix when no id is supplied", async () => {
    const ws = await store.create({ tenantId: "tenant1" });
    expect(ws.id).toMatch(/^ws_/);
    expect(ws.tenantId).toBe("tenant1");
    expect(ws.createdAt).toBeInstanceOf(Date);
  });

  it("uses a user-supplied id as-is", async () => {
    const ws = await store.create({ tenantId: "tenant1", id: "my-workspace" });
    expect(ws.id).toBe("my-workspace");
    const found = await store.getById("tenant1", "my-workspace");
    expect(found).not.toBeNull();
    expect(found!.id).toBe("my-workspace");
  });

  it("is idempotent for a repeated user-supplied id (shared by many sessions)", async () => {
    const first = await store.create({ tenantId: "tenant1", id: "shared" });
    const second = await store.create({ tenantId: "tenant1", id: "shared" });
    expect(second.id).toBe("shared");
    expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
  });

  it("isolates workspaces by tenant (same id, different tenants)", async () => {
    await store.create({ tenantId: "tenant1", id: "ws" });
    await store.create({ tenantId: "tenant2", id: "ws" });

    const t1 = await store.getById("tenant1", "ws");
    const t2 = await store.getById("tenant2", "ws");
    expect(t1).not.toBeNull();
    expect(t2).not.toBeNull();
    expect(t1!.tenantId).toBe("tenant1");
    expect(t2!.tenantId).toBe("tenant2");
  });

  it("returns null for a workspace in another tenant", async () => {
    await store.create({ tenantId: "tenant1", id: "ws" });
    const cross = await store.getById("tenant2", "ws");
    expect(cross).toBeNull();
  });

  it("stores a name when supplied at creation", async () => {
    const ws = await store.create({ tenantId: "tenant1", id: "named", name: "My Files" });
    expect(ws.name).toBe("My Files");
    const found = await store.getById("tenant1", "named");
    expect(found!.name).toBe("My Files");
  });

  it("does not clobber an existing name on idempotent re-create", async () => {
    await store.create({ tenantId: "tenant1", id: "keep", name: "Original" });
    const second = await store.create({ tenantId: "tenant1", id: "keep", name: "Renamed" });
    expect(second.name).toBe("Original");
  });

  it("lists a tenant's workspaces ordered by created_at ascending", async () => {
    await store.create({ tenantId: "tenant1", id: "a", name: "A" });
    await store.create({ tenantId: "tenant1", id: "b", name: "B" });
    await store.create({ tenantId: "tenant2", id: "c", name: "C" });

    const list = await store.list("tenant1");
    expect(list.map((w) => w.id)).toEqual(["a", "b"]);
    expect(list.every((w) => w.tenantId === "tenant1")).toBe(true);
  });

  it("returns an empty list for a tenant with no workspaces", async () => {
    expect(await store.list("nobody")).toEqual([]);
  });

  it("binds a Session to a Workspace immutably", async () => {
    const sessions = new PgSessionStore(harness.pool);
    const ws = await store.create({ tenantId: "tenant1", id: "bound" });

    const session = await sessions.create({
      tenantId: "tenant1",
      agentId: mockAgent.id,
      agent: mockAgent,
      workspaceId: ws.id,
    });
    expect(session.workspaceId).toBe("bound");

    // No SessionStore mutation touches workspaceId: status changes leave the
    // binding intact (immutability enforced by the store's write surface).
    const running = await sessions.updateStatus(session.id, "running");
    expect(running!.workspaceId).toBe("bound");
    const terminated = await sessions.terminate(session.id);
    expect(terminated!.workspaceId).toBe("bound");
  });

  it("lets multiple Sessions bind one Workspace concurrently", async () => {
    const sessions = new PgSessionStore(harness.pool);
    const ws = await store.create({ tenantId: "tenant1", id: "shared" });

    const a = await sessions.create({
      tenantId: "tenant1",
      agentId: mockAgent.id,
      agent: mockAgent,
      workspaceId: ws.id,
    });
    const b = await sessions.create({
      tenantId: "tenant1",
      agentId: mockAgent.id,
      agent: mockAgent,
      workspaceId: ws.id,
    });

    expect(a.workspaceId).toBe("shared");
    expect(b.workspaceId).toBe("shared");
    expect(a.id).not.toBe(b.id);
  });
});
