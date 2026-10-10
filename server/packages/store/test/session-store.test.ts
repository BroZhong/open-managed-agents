import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PgSessionStore } from "../src/postgres/session-store.js";
import { PgWorkspaceMetadataStore } from "../src/postgres/workspace-metadata-store.js";
import { PgPendingEventStore } from "../src/postgres/pending-event-store.js";
import { PgEventLogStore } from "../src/postgres/event-log-store.js";
import { PendingEventClaimLostError } from "../src/errors.js";
import { decodeSessionUpdatedAtCursor } from "../src/session-list-cursor.js";
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

  it("persists a Session thinking override independently of its Agent snapshot", async () => {
    const session = await store.create({ tenantId: "tenant1", agentId: mockAgent.id,
      agent: { ...mockAgent, thinking: "medium" }, workspaceId: await newWorkspace() });
    expect(session.thinking).toBeNull();
    await store.setThinking(session.id, "off");
    const reloaded = await new PgSessionStore(harness.pool).getById(session.id);
    expect(reloaded?.thinking).toBe("off");
    expect(reloaded?.agent.thinking).toBe("medium");
    await store.setThinking(session.id, null);
    expect((await store.getById(session.id))?.thinking).toBeNull();
  });

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

  it("fences turn-owned status updates by pending generation", async () => {
    const created = await store.create({
      tenantId: "tenant1",
      agentId: mockAgent.id,
      agent: mockAgent,
      workspaceId: await newWorkspace(),
    });
    const pending = new PgPendingEventStore(harness.pool);
    const input = await pending.enqueue(created.id, {
      type: "user.message",
      data: {},
      sessionThreadId: "sthr_primary",
    });
    const first = await pending.claim(created.id, "host_a", 60_000);

    await expect(store.updateStatusIfClaimed(created.id, "running", {
      eventId: input.id,
      ...first!,
    })).resolves.toMatchObject({ status: "running" });
    await pending.releaseClaim(created.id, input.id, first!);
    await pending.claim(created.id, "host_b", 60_000);

    await expect(store.updateStatusIfClaimed(created.id, "idle", {
      eventId: input.id,
      ...first!,
    })).rejects.toMatchObject({ code: "pending_event_claim_lost" });
    expect((await store.getById(created.id))?.status).toBe("running");
  });

  it("never revives a terminated session even while its pending fence is live", async () => {
    const created = await store.create({
      tenantId: "tenant1",
      agentId: mockAgent.id,
      agent: mockAgent,
      workspaceId: await newWorkspace(),
    });
    const pending = new PgPendingEventStore(harness.pool);
    const input = await pending.enqueue(created.id, {
      type: "user.message",
      data: {},
      sessionThreadId: "sthr_primary",
    });
    const claim = await pending.claim(created.id, "host_a", 60_000);
    await store.terminate(created.id);

    await expect(store.updateStatusIfClaimed(created.id, "running", {
      eventId: input.id,
      ...claim!,
    })).resolves.toBeNull();
    expect((await store.getById(created.id))?.status).toBe("terminated");
  });

  it("termination atomically removes a remote Host claim and fences all later writes", async () => {
    const created = await store.create({
      tenantId: "tenant1",
      agentId: mockAgent.id,
      agent: mockAgent,
      workspaceId: await newWorkspace(),
    });
    const pending = new PgPendingEventStore(harness.pool);
    const input = await pending.enqueue(created.id, {
      type: "user.message",
      data: {},
      sessionThreadId: "sthr_primary",
    });
    const claim = await pending.claim(created.id, "remote_host", 60_000);
    const fence = {
      eventId: input.id,
      ownerId: claim!.ownerId,
      generation: claim!.generation,
    };

    await store.terminate(created.id);

    expect(await pending.count(created.id)).toBe(0);
    expect(await pending.renewClaim(created.id, input.id, claim!, 60_000)).toBe(false);
    expect(await pending.ack(created.id, input.id, claim!)).toBe(false);
    await expect(new PgEventLogStore(harness.pool).append(created.id, {
      type: "agent.message",
      data: {},
      sessionThreadId: "sthr_primary",
      pendingFence: fence,
    })).rejects.toBeInstanceOf(PendingEventClaimLostError);
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

  it("filters by Workspace, Agent and Tenant before paginating five Sessions", async () => {
    const workspaceId = await newWorkspace();
    const neighborId = await newWorkspace();
    const input = { tenantId: "tenant1", agentId: mockAgent.id, agent: mockAgent, workspaceId };
    const unrelated = [];
    for (let index = 0; index < 8; index++) {
      unrelated.push(await store.create({ ...input, workspaceId: neighborId }));
    }
    unrelated.push(await store.create({ ...input, agentId: "agent_other" }));
    unrelated.push(await store.create({ ...input, tenantId: "tenant2" }));
    unrelated.push(await store.create({ ...input, loopId: "loop_review" }));
    unrelated.push(await store.create({ ...input, delegation: {
      parentSessionId: "sess_parent", parentTurnId: "turn_parent", parentToolUseId: "tool_child", sandboxSessionId: "sess_parent",
    } }));
    const deleted = await store.create(input);
    await store.softDelete(deleted.id);
    unrelated.push(deleted);
    // Put excluded records before the project's records in the actual SQL order.
    for (const [index, session] of unrelated.entries()) {
      await harness.pool.query("UPDATE sessions SET id = $2 WHERE id = $1", [session.id, `sess_a_${String(index).padStart(2, "0")}`]);
    }
    const expected = [];
    for (let index = 0; index < 7; index++) {
      const session = await store.create(input);
      const id = `sess_z_${index}`;
      await harness.pool.query("UPDATE sessions SET id = $2 WHERE id = $1", [session.id, id]);
      expected.push(id);
    }

    const opts = { workspaceId, agentId: mockAgent.id, withoutLoop: true, excludeDelegated: true, limit: 5 };
    const page1 = await store.list("tenant1", opts);
    expect(page1.data.map((session) => session.id)).toEqual(expected.slice(0, 5));
    expect(page1.hasMore).toBe(true);
    const page2 = await store.list("tenant1", { ...opts, cursor: page1.data[4].id });
    expect(page2.data.map((session) => session.id)).toEqual(expected.slice(5));
    expect(page2.hasMore).toBe(false);
    expect(await store.list("tenant1", { ...opts, excludedWorkspaceIds: [workspaceId] })).toEqual({ data: [], hasMore: false });
  });

  it("excludes named and deleted Workspace IDs before paginating loose Sessions", async () => {
    const named = await newWorkspace();
    const deleted = await newWorkspace();
    const loose = await newWorkspace();
    const input = { tenantId: "tenant1", agentId: mockAgent.id, agent: mockAgent, workspaceId: named };
    for (let index = 0; index < 8; index++) {
      const session = await store.create({ ...input, workspaceId: index % 2 ? named : deleted });
      await harness.pool.query("UPDATE sessions SET id = $2 WHERE id = $1", [session.id, `sess_a_${index}`]);
    }
    const expected = [];
    for (let index = 0; index < 7; index++) {
      const session = await store.create({ ...input, workspaceId: loose });
      const id = `sess_z_${index}`;
      await harness.pool.query("UPDATE sessions SET id = $2 WHERE id = $1", [session.id, id]);
      expected.push(id);
    }
    const opts = { agentId: mockAgent.id, excludedWorkspaceIds: [named, deleted], limit: 5 };
    const page1 = await store.list("tenant1", opts);
    expect(page1.data.map((session) => session.id)).toEqual(expected.slice(0, 5));
    expect(page1.hasMore).toBe(true);
    const page2 = await store.list("tenant1", { ...opts, cursor: page1.data[4].id });
    expect(page2.data.map((session) => session.id)).toEqual(expected.slice(5));
    expect(page2.hasMore).toBe(false);
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

  it("paginates a Workspace by modification time with stable ties and a saved boundary", async () => {
    const workspaceId = await newWorkspace();
    const input = { tenantId: "tenant1", agentId: mockAgent.id, agent: mockAgent, workspaceId };
    const rows = [
      { id: "sess_z_old_touched", day: "10" },
      { id: "sess_a_new", day: "09" },
      { id: "sess_d_tie", day: "08" },
      { id: "sess_c_tie", day: "08" },
      { id: "sess_b_tie", day: "08" },
      { id: "sess_a_tie", day: "08" },
      { id: "sess_final", day: "07" },
    ];
    for (const [index, row] of rows.entries()) {
      const session = await store.create(input);
      await harness.pool.query(
        "UPDATE sessions SET id = $2, created_at = $3, updated_at = $4 WHERE id = $1",
        [session.id, row.id, `2026-09-0${index + 1}T00:00:00.000Z`, `2026-10-${row.day}T00:00:00.000Z`],
      );
    }
    // These newer Sessions must be filtered before the requested page limit.
    for (const extra of [
      { workspaceId: await newWorkspace() },
      { agentId: "agent_other" },
      { tenantId: "tenant2", workspaceId: await newWorkspace("tenant2") },
      { loopId: "loop_review" },
      { delegation: { parentSessionId: "sess_parent", parentTurnId: "turn_parent", parentToolUseId: "tool_child", sandboxSessionId: "sess_parent" } },
    ]) {
      const session = await store.create({ ...input, ...extra });
      await harness.pool.query("UPDATE sessions SET updated_at = $2 WHERE id = $1", [session.id, "2026-10-11T00:00:00.000Z"]);
    }
    const opts = { workspaceId, agentId: mockAgent.id, withoutLoop: true, excludeDelegated: true, order: "updated_at" as const, limit: 5 };
    const first = await store.list("tenant1", opts);
    expect(first.data.map((session) => session.id)).toEqual(rows.slice(0, 5).map((row) => row.id));
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeDefined();

    // Paging uses the original timestamp even if the last visible Session moves or disappears.
    await store.setTitle("sess_b_tie", "Updated after loading page one");
    const second = await store.list("tenant1", { ...opts, cursor: first.nextCursor });
    expect(second.data.map((session) => session.id)).toEqual(["sess_a_tie", "sess_final"]);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeUndefined();
    await store.softDelete("sess_b_tie");
    expect(await store.list("tenant1", { ...opts, cursor: first.nextCursor })).toEqual(second);
    expect(await store.list("tenant1", { ...opts, excludedWorkspaceIds: [workspaceId] })).toEqual({ data: [], hasMore: false });
  });

  it("preserves database timestamp precision in modification-order cursor boundaries", async () => {
    const input = { tenantId: "tenant1", agentId: mockAgent.id, agent: mockAgent, workspaceId: await newWorkspace() };
    await store.create(input);
    await store.create(input);
    const fixture = await harness.pool.query("SELECT * FROM sessions ORDER BY id DESC");
    const timestamp = "2026-10-10T00:00:00.123456+00:00";
    // pg's default Date parser truncates microseconds. Supply the separate SQL text
    // result explicitly because pg-mem also stores timestamps as millisecond Dates.
    const query = vi.spyOn(harness.pool, "query");
    try {
      query.mockResolvedValueOnce({ ...fixture, rows: fixture.rows.map((row) => ({
        ...row, updated_at: new Date(timestamp), cursor_updated_at: timestamp,
      })) });
      const first = await store.list("tenant1", { order: "updated_at", limit: 1 });
      expect(first.data[0].updatedAt.toISOString()).toBe("2026-10-10T00:00:00.123Z");
      expect(decodeSessionUpdatedAtCursor(first.nextCursor!)).toEqual({ updatedAt: timestamp, id: first.data[0].id });
      query.mockClear();
      await store.list("tenant1", { order: "updated_at", limit: 1, cursor: first.nextCursor });
      expect(query.mock.calls[0][1]).toEqual(["tenant1", timestamp, first.data[0].id, 2]);
    } finally {
      query.mockRestore();
    }
  });

  it("lists a Loop's Sessions newest first with stable cursor pagination", async () => {
    const workspaceId = await newWorkspace();
    const created = await Promise.all([
      store.create({
        tenantId: "tenant1",
        agentId: mockAgent.id,
        agent: mockAgent,
        workspaceId,
        loopId: "loop_review",
      }),
      store.create({
        tenantId: "tenant1",
        agentId: mockAgent.id,
        agent: mockAgent,
        workspaceId,
        loopId: "loop_review",
      }),
      store.create({
        tenantId: "tenant1",
        agentId: mockAgent.id,
        agent: mockAgent,
        workspaceId,
        loopId: "loop_review",
      }),
    ]);
    const rows = [
      { from: created[0].id, to: "sess_a_old", at: "2026-07-14T00:05:00.000Z" },
      { from: created[1].id, to: "sess_m_mid", at: "2026-07-14T00:10:00.000Z" },
      { from: created[2].id, to: "sess_z_new", at: "2026-07-14T00:15:00.000Z" },
    ];
    for (const row of rows) {
      await harness.pool.query(
        `UPDATE sessions SET id = $2, created_at = $3 WHERE id = $1`,
        [row.from, row.to, row.at],
      );
    }

    const page1 = await store.list("tenant1", { loopId: "loop_review", limit: 2 });
    expect(page1.data.map((session) => session.id)).toEqual(["sess_z_new", "sess_m_mid"]);
    expect(page1.hasMore).toBe(true);

    const page2 = await store.list("tenant1", {
      loopId: "loop_review",
      limit: 2,
      cursor: page1.data[1].id,
    });
    expect(page2.data.map((session) => session.id)).toEqual(["sess_a_old"]);
    expect(page2.hasMore).toBe(false);
  });

  it("excludes delegated children before pagination while retaining SQL and JSON null origins", async () => {
    const input = { tenantId: "tenant1", agentId: mockAgent.id, agent: mockAgent, workspaceId: await newWorkspace() };
    const child = await store.create({ ...input, delegation: {
      parentSessionId: "sess_parent", parentTurnId: "turn_parent", parentToolUseId: "tool_child", sandboxSessionId: "sess_parent",
    } });
    const roots = [await store.create(input), await store.create(input)];
    // Keep a child before both roots, and exercise the legacy SQL NULL representation.
    for (const [index, session] of [child, ...roots].entries()) {
      await harness.pool.query("UPDATE sessions SET id = $2 WHERE id = $1", [session.id, `sess_${index}`]);
    }
    await harness.pool.query("UPDATE sessions SET delegation = NULL WHERE id = $1", ["sess_1"]);
    expect((await store.list("tenant1")).data).toHaveLength(3);
    expect((await store.list("tenant1", { excludeDelegated: false })).data).toHaveLength(3);
    const first = await store.list("tenant1", { excludeDelegated: true, limit: 1 });
    expect(first.data.map((session) => session.id)).toEqual(["sess_1"]);
    expect(first.hasMore).toBe(true);
    const second = await store.list("tenant1", { excludeDelegated: true, limit: 1, cursor: first.data[0].id });
    expect(second.data.map((session) => session.id)).toEqual(["sess_2"]);
    expect(second.hasMore).toBe(false);
  });

  it("excludes Loop-owned Sessions at the query boundary", async () => {
    const workspaceId = await newWorkspace();
    const loose = await store.create({
      tenantId: "tenant1",
      agentId: mockAgent.id,
      agent: mockAgent,
      workspaceId,
    });
    await store.create({
      tenantId: "tenant1",
      agentId: mockAgent.id,
      agent: mockAgent,
      workspaceId,
      loopId: "loop_review",
    });

    const result = await store.list("tenant1", { withoutLoop: true });
    expect(result.data.map((session) => session.id)).toEqual([loose.id]);
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
