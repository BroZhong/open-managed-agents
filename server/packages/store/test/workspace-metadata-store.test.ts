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
  runtime: "claude-code",
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
