import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PgAgentStore } from "../src/postgres/agent-store.js";
import { PgLoopStore } from "../src/postgres/loop-store.js";
import { PgPendingEventStore } from "../src/postgres/pending-event-store.js";
import { PgSessionStore } from "../src/postgres/session-store.js";
import { PgWorkspaceMetadataStore } from "../src/postgres/workspace-metadata-store.js";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";

const realPgIt = process.env.PG_TEST_URL ? it : it.skip;

describe("PgLoopStore", () => {
  let harness: PgTestHarness;
  let loops: PgLoopStore;
  let agents: PgAgentStore;
  let pending: PgPendingEventStore;

  beforeAll(async () => {
    harness = await createPgTestHarness({ allowUnsupportedLockSyntax: true });
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
    loops = new PgLoopStore(harness.pool);
    agents = new PgAgentStore(harness.pool);
    pending = new PgPendingEventStore(harness.pool);
  });

  it("atomically dispatches one due Loop into a linked Session and pending Turn", async () => {
    const start = new Date("2026-07-14T00:00:00.000Z");
    const agent = await agents.create({
      tenantId: "tenant_1",
      name: "Session Analyst",
      model: "openai-codex/gpt-5.5",
      system: "Find concrete improvements.",
      runtime: "pi-agent",
      mcpServers: [{
        catalogId: "aliyun-rds-supabase",
        name: "session-data",
        description: "Read recent Sessions",
      }],
    });
    const loop = await loops.create({
      tenantId: "tenant_1",
      agentId: agent.id,
      name: "Weekly Session Review",
      description: "Review the last seven days",
      prompt: "Read Sessions from the last seven days and propose Agent improvements.",
      intervalMinutes: 5,
      enabled: true,
      now: start,
    });

    expect(await loops.dispatchDue(new Date("2026-07-14T00:04:59.999Z"), 10)).toEqual([]);

    const dispatched = await loops.dispatchDue(
      new Date("2026-07-14T00:05:00.000Z"),
      10,
    );

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].session).toMatchObject({
      tenantId: "tenant_1",
      agentId: agent.id,
      loopId: loop.id,
      title: "Weekly Session Review",
      status: "idle",
    });
    expect(dispatched[0].session.agent.mcpServers).toEqual(agent.mcpServers);
    expect(await pending.peek(dispatched[0].session.id)).toMatchObject({
      type: "user.message",
      data: {
        content: [{
          type: "text",
          text: "Read Sessions from the last seven days and propose Agent improvements.",
        }],
      },
      sessionThreadId: "sthr_primary",
    });

    const updated = await loops.getById(loop.id);
    expect(updated?.lastRunAt).toEqual(new Date("2026-07-14T00:05:00.000Z"));
    expect(updated?.nextRunAt).toEqual(new Date("2026-07-14T00:10:00.000Z"));
    expect(await loops.dispatchDue(new Date("2026-07-14T00:05:00.000Z"), 10)).toEqual([]);
  });

  it("attributes only run-now dispatches to their authenticating API key", async () => {
    const start = new Date("2026-07-14T00:00:00.000Z");
    const agent = await agents.create({
      tenantId: "tenant_1",
      name: "Session Analyst",
      model: "openai-codex/gpt-5.5",
      system: "Find concrete improvements.",
      runtime: "pi-agent",
    });
    const loop = await loops.create({
      tenantId: "tenant_1",
      agentId: agent.id,
      name: "Weekly Session Review",
      prompt: "Analyze recent Sessions.",
      intervalMinutes: 5,
      enabled: true,
      now: start,
    });

    const manual = await loops.dispatchNow(
      loop.id,
      "tenant_1",
      new Date("2026-07-14T00:01:00.000Z"),
      "key_loop_run",
    );
    expect((await pending.peek(manual!.session.id))?.apiKeyId).toBe("key_loop_run");

    const [scheduled] = await loops.dispatchDue(
      new Date("2026-07-14T00:05:00.000Z"),
      1,
    );
    expect((await pending.peek(scheduled.session.id))?.apiKeyId).toBeUndefined();
  });

  it("disables an orphaned Loop instead of failing every due poll", async () => {
    const start = new Date("2026-07-14T00:00:00.000Z");
    const agent = await agents.create({
      tenantId: "tenant_1",
      name: "Temporary Agent",
      model: "openai-codex/gpt-5.5",
      system: "Analyze Sessions.",
      runtime: "pi-agent",
    });
    const loop = await loops.create({
      tenantId: "tenant_1",
      agentId: agent.id,
      name: "Orphan candidate",
      prompt: "Analyze recent Sessions.",
      intervalMinutes: 5,
      enabled: true,
      now: start,
    });
    await agents.delete(agent.id);

    await expect(loops.dispatchDue(new Date("2026-07-14T00:05:00.000Z"), 10))
      .resolves.toEqual([]);
    expect(await loops.getById(loop.id)).toMatchObject({ enabled: false });
  });

  it("does not update a Loop through a different tenant boundary", async () => {
    const start = new Date("2026-07-14T00:00:00.000Z");
    const agent = await agents.create({
      tenantId: "tenant_1",
      name: "Session Analyst",
      model: "openai-codex/gpt-5.5",
      system: "Analyze Sessions.",
      runtime: "pi-agent",
    });
    const loop = await loops.create({
      tenantId: "tenant_1",
      agentId: agent.id,
      name: "Original name",
      prompt: "Analyze recent Sessions.",
      intervalMinutes: 5,
      enabled: true,
      now: start,
    });

    await expect(loops.update(loop.id, "tenant_2", {
      name: "Cross-tenant change",
      now: new Date("2026-07-14T00:01:00.000Z"),
    })).resolves.toBeNull();
    expect(await loops.getById(loop.id)).toMatchObject({
      tenantId: "tenant_1",
      name: "Original name",
      updatedAt: start,
    });
  });

  realPgIt("serializes interval changes with a concurrent re-enable", async () => {
    const start = new Date("2026-07-14T00:00:00.000Z");
    const agent = await agents.create({
      tenantId: "tenant_1",
      name: "Session Analyst",
      model: "openai-codex/gpt-5.5",
      system: "Analyze Sessions.",
      runtime: "pi-agent",
    });
    const loop = await loops.create({
      tenantId: "tenant_1",
      agentId: agent.id,
      name: "Concurrent update",
      prompt: "Analyze recent Sessions.",
      intervalMinutes: 5,
      enabled: false,
      now: start,
    });

    const blocker = await harness.pool.connect();
    let intervalUpdate: Promise<unknown> | undefined;
    let enableUpdate: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT id FROM loops WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
        [loop.id, "tenant_1"],
      );

      intervalUpdate = loops.update(loop.id, "tenant_1", {
        intervalMinutes: 10,
        now: new Date("2026-07-14T01:00:00.000Z"),
      });
      await waitForLoopLockWaiters(blocker, 1);

      enableUpdate = loops.update(loop.id, "tenant_1", {
        enabled: true,
        now: new Date("2026-07-14T02:00:00.000Z"),
      });
      await waitForLoopLockWaiters(blocker, 2);

      await blocker.query("COMMIT");
      await Promise.all([intervalUpdate, enableUpdate]);
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
      // Prevent a failed lock-observation assertion from leaving rejected
      // update promises unobserved while the harness is being torn down.
      await Promise.allSettled([intervalUpdate, enableUpdate].filter(Boolean));
    }

    expect(await loops.getById(loop.id)).toMatchObject({
      intervalMinutes: 10,
      enabled: true,
      nextRunAt: new Date("2026-07-14T02:10:00.000Z"),
    });
  });

  realPgIt("rolls back every dispatch record when pending input insertion fails", async () => {
    const start = new Date("2026-07-14T00:00:00.000Z");
    const agent = await agents.create({
      tenantId: "tenant_1",
      name: "Session Analyst",
      model: "openai-codex/gpt-5.5",
      system: "Analyze Sessions.",
      runtime: "pi-agent",
    });
    const loop = await loops.create({
      tenantId: "tenant_1",
      agentId: agent.id,
      name: "Failure rollback",
      prompt: "Analyze recent Sessions.",
      intervalMinutes: 5,
      enabled: true,
      now: start,
    });
    await harness.pool.query(`
      CREATE FUNCTION reject_loop_pending_insert() RETURNS trigger
      LANGUAGE plpgsql AS $function$
      BEGIN
        RAISE EXCEPTION 'simulated pending-event write failure';
      END
      $function$;
      CREATE TRIGGER reject_loop_pending_insert
      BEFORE INSERT ON pending_events
      FOR EACH ROW EXECUTE FUNCTION reject_loop_pending_insert();
    `);

    await expect(loops.dispatchDue(
      new Date("2026-07-14T00:05:00.000Z"),
      1,
    )).rejects.toThrow("simulated pending-event write failure");

    const sessions = new PgSessionStore(harness.pool);
    const workspaces = new PgWorkspaceMetadataStore(harness.pool);
    expect((await sessions.list("tenant_1")).data).toEqual([]);
    expect(await workspaces.list("tenant_1")).toEqual([]);
    expect(await pending.listPendingSessionIds()).toEqual([]);
    const unchangedLoop = await loops.getById(loop.id);
    expect(unchangedLoop?.lastRunAt).toBeUndefined();
    expect(unchangedLoop?.nextRunAt).toEqual(
      new Date("2026-07-14T00:05:00.000Z"),
    );
  });
});

async function waitForLoopLockWaiters(
  observer: { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> },
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    // pg_stat_activity snapshots are cached for the observer's transaction;
    // clear it so newly queued connections become visible while this client
    // continues holding the row lock.
    await observer.query("SELECT pg_stat_clear_snapshot()");
    const { rows } = await observer.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pg_stat_activity
       WHERE pid <> pg_backend_pid()
         AND datname = current_database()
         AND wait_event_type = 'Lock'
         AND query ILIKE '%loops%'`,
    );
    if (Number(rows[0]?.count ?? 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expected} Loop row-lock waiter(s)`);
}
