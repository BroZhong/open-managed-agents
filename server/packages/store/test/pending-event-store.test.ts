import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PgEventLogStore } from "../src/postgres/event-log-store.js";
import { PgPendingEventStore } from "../src/postgres/pending-event-store.js";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";

describe("PgPendingEventStore", () => {
  let harness: PgTestHarness;
  let store: PgPendingEventStore;

  beforeAll(async () => {
    harness = await createPgTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
    store = new PgPendingEventStore(harness.pool);
  });

  async function seedSession(id: string, status: "idle" | "running" | "terminated" = "idle") {
    const now = new Date();
    await harness.pool.query(
      `INSERT INTO sessions
         (id, tenant_id, agent_id, status, agent, workspace_id, created_at, updated_at, terminated_at)
       VALUES ($1, 'tenant_1', 'agent_1', $2, $3, 'workspace_1', $4, $4, $5)`,
      [
        id,
        status,
        JSON.stringify({
          id: "agent_1",
          tenantId: "tenant_1",
          name: "Agent",
          model: "model",
          system: "system",
          runtime: "mock",
          createdAt: now,
          updatedAt: now,
        }),
        now,
        status === "terminated" ? now : null,
      ],
    );
  }

  it("atomically enqueues a whole batch only while the Session is active", async () => {
    await seedSession("sess_active");
    const accepted = await store.enqueueBatchIfSessionActive("sess_active", [
      { type: "user.message", data: { n: 1 }, sessionThreadId: "t" },
      { type: "user.message", data: { n: 2 }, sessionThreadId: "t" },
    ]);
    expect(accepted?.map((event) => event.data)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(await store.count("sess_active")).toBe(2);

    await seedSession("sess_terminated", "terminated");
    await expect(store.enqueueBatchIfSessionActive("sess_terminated", [
      { type: "user.message", data: { n: 3 }, sessionThreadId: "t" },
    ])).resolves.toBeNull();
    expect(await store.count("sess_terminated")).toBe(0);
  });

  it("rolls back the complete ingress batch if any insert fails", async () => {
    await seedSession("sess_1");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await expect(store.enqueueBatchIfSessionActive("sess_1", [
      { type: "user.message", data: { ok: true }, sessionThreadId: "t" },
      { type: "user.message", data: cyclic, sessionThreadId: "t" },
    ])).rejects.toThrow();
    expect(await store.count("sess_1")).toBe(0);
  });

  it("enqueue writes an event and dequeue returns it FIFO then deletes", async () => {
    await store.enqueue("sess_1", {
      type: "user.message",
      data: { content: "hello" },
      sessionThreadId: "sthr_primary",
      apiKeyId: "apikey_1",
    });

    const event = await store.dequeue("sess_1");
    expect(event).not.toBeNull();
    expect(event!.sessionId).toBe("sess_1");
    expect(event!.type).toBe("user.message");
    expect(event!.data).toEqual({ content: "hello" });
    expect(event!.sessionThreadId).toBe("sthr_primary");
    expect(event!.apiKeyId).toBe("apikey_1");
    expect(event!.arrivedAt).toBeInstanceOf(Date);
    expect(event!.id).toBeDefined();

    const next = await store.dequeue("sess_1");
    expect(next).toBeNull();
  });

  it("preserves API key attribution through batch enqueue and claim", async () => {
    await seedSession("sess_1");
    await store.enqueueBatchIfSessionActive("sess_1", [{
      type: "user.message",
      data: { content: "hello" },
      sessionThreadId: "sthr_primary",
      apiKeyId: "apikey_batch",
    }]);

    const claim = await store.claim("sess_1", "host_1", 60_000);
    expect(claim?.event.apiKeyId).toBe("apikey_batch");
  });

  it("dequeue returns events in FIFO order", async () => {
    await store.enqueue("sess_1", { type: "m", data: { n: 1 }, sessionThreadId: "t" });
    await store.enqueue("sess_1", { type: "m", data: { n: 2 }, sessionThreadId: "t" });
    await store.enqueue("sess_1", { type: "m", data: { n: 3 }, sessionThreadId: "t" });

    expect((await store.dequeue("sess_1"))!.data).toEqual({ n: 1 });
    expect((await store.dequeue("sess_1"))!.data).toEqual({ n: 2 });
    expect((await store.dequeue("sess_1"))!.data).toEqual({ n: 3 });
  });

  it("peek returns the next event without removing it", async () => {
    await store.enqueue("sess_1", {
      type: "user.message",
      data: { content: "first" },
      sessionThreadId: "sthr_primary",
    });

    const peeked = await store.peek("sess_1");
    expect(peeked).not.toBeNull();
    expect(peeked!.data).toEqual({ content: "first" });

    const peekedAgain = await store.peek("sess_1");
    expect(peekedAgain!.id).toBe(peeked!.id);

    const dequeued = await store.dequeue("sess_1");
    expect(dequeued!.id).toBe(peeked!.id);
  });

  it("ack removes exactly the peeked FIFO head and is idempotent", async () => {
    const first = await store.enqueue("sess_1", {
      type: "user.message",
      data: { content: "first" },
      sessionThreadId: "sthr_primary",
    });
    const second = await store.enqueue("sess_1", {
      type: "user.message",
      data: { content: "second" },
      sessionThreadId: "sthr_primary",
    });

    expect(await store.ack("sess_1", second.id)).toBe(false);
    expect((await store.peek("sess_1"))?.id).toBe(first.id);
    expect(await store.ack("sess_1", first.id)).toBe(true);
    expect((await store.peek("sess_1"))?.id).toBe(second.id);
    expect(await store.ack("sess_1", first.id)).toBe(false);
  });

  it("grants the FIFO head to exactly one live owner", async () => {
    const event = await store.enqueue("sess_1", {
      type: "user.message",
      data: { content: "one execution" },
      sessionThreadId: "sthr_primary",
    });
    const peer = new PgPendingEventStore(harness.pool);

    const claims = await Promise.all([
      store.claim("sess_1", "host_a", 60_000),
      peer.claim("sess_1", "host_b", 60_000),
    ]);
    const winner = claims.find((claim) => claim !== null)!;
    const loser = claims.find((claim) => claim === null);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(loser).toBeNull();
    expect(winner.event.id).toBe(event.id);
    expect(winner.generation).toBe(1);
    expect(winner.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(await store.ack("sess_1", event.id)).toBe(false);
  });

  it("expires and fences an old owner before a new attempt can ack", async () => {
    const event = await store.enqueue("sess_1", {
      type: "user.message",
      data: {},
      sessionThreadId: "sthr_primary",
    });
    const first = await store.claim("sess_1", "host_a", 60_000);
    expect(first).not.toBeNull();
    expect(await store.claim("sess_1", "host_b", 60_000)).toBeNull();

    // White-box the lease boundary without a timing-sensitive sleep.
    await harness.pool.query(
      `UPDATE pending_events SET claim_expires_at = $2 WHERE id = $1`,
      [event.id, new Date(Date.now() - 1_000)],
    );

    const second = await store.claim("sess_1", "host_b", 60_000);
    expect(second).not.toBeNull();
    expect(second!.generation).toBe(first!.generation + 1);
    expect(await store.renewClaim("sess_1", event.id, first!, 60_000)).toBe(false);
    expect(await store.releaseClaim("sess_1", event.id, first!)).toBe(false);
    expect(await store.ack("sess_1", event.id, first!)).toBe(false);
    expect(await store.renewClaim("sess_1", event.id, second!, 60_000)).toBe(true);
    expect(await store.ack("sess_1", event.id, second!)).toBe(true);
    expect(await store.peek("sess_1")).toBeNull();
  });

  it("release keeps the input and forces a fresh fenced generation", async () => {
    const event = await store.enqueue("sess_1", {
      type: "user.message",
      data: {},
      sessionThreadId: "sthr_primary",
    });
    const first = await store.claim("sess_1", "host_a", 60_000);
    expect(await store.releaseClaim("sess_1", event.id, first!)).toBe(true);

    const second = await store.claim("sess_1", "host_a", 60_000);
    expect(second?.generation).toBe(first!.generation + 1);
    expect(await store.count("sess_1")).toBe(1);
  });

  it("dequeue returns null on empty queue", async () => {
    const result = await store.dequeue("sess_nonexistent");
    expect(result).toBeNull();
  });

  it("count returns the number of pending events for a session", async () => {
    expect(await store.count("sess_1")).toBe(0);

    await store.enqueue("sess_1", { type: "user.message", data: {}, sessionThreadId: "sthr_primary" });
    await store.enqueue("sess_1", { type: "user.message", data: {}, sessionThreadId: "sthr_primary" });
    await store.enqueue("sess_1", { type: "user.message", data: {}, sessionThreadId: "sthr_primary" });

    expect(await store.count("sess_1")).toBe(3);

    await store.dequeue("sess_1");
    expect(await store.count("sess_1")).toBe(2);
  });

  it("lists only the input no live attempt is executing (issue #114)", async () => {
    await seedSession("sess_1");
    const first = await store.enqueue("sess_1", { type: "user.message", data: { n: 1 }, sessionThreadId: "t" });
    const second = await store.enqueue("sess_1", { type: "user.message", data: { n: 2 }, sessionThreadId: "t" });

    // Nothing claimed: every entry is still input the user is waiting on.
    expect((await store.listUnclaimed("sess_1", 10)).map((e) => e.id)).toEqual([
      first.id,
      second.id,
    ]);

    // The claimed head is promoted into the event log, so it is history now and
    // must not also be reported as queued — only the tail is still waiting.
    const claim = await store.claim("sess_1", "host_a", 60_000);
    expect(claim?.event.id).toBe(first.id);
    expect((await store.listUnclaimed("sess_1", 10)).map((e) => e.id)).toEqual([second.id]);

    // An expired lease means no attempt owns it: it is waiting input again.
    await store.releaseClaim("sess_1", first.id, claim!);
    expect((await store.listUnclaimed("sess_1", 10)).map((e) => e.id)).toEqual([
      first.id,
      second.id,
    ]);

    expect((await store.listUnclaimed("sess_1", 1)).map((e) => e.id)).toEqual([first.id]);
    await expect(store.listUnclaimed("sess_1", 0)).rejects.toThrow(RangeError);
  });

  it("multiple sessions have independent pending queues", async () => {
    await store.enqueue("sess_1", { type: "user.message", data: { msg: "a" }, sessionThreadId: "sthr_primary" });
    await store.enqueue("sess_2", { type: "user.message", data: { msg: "b" }, sessionThreadId: "sthr_primary" });
    await store.enqueue("sess_1", { type: "user.message", data: { msg: "c" }, sessionThreadId: "sthr_primary" });

    expect(await store.count("sess_1")).toBe(2);
    expect(await store.count("sess_2")).toBe(1);

    const from1 = await store.dequeue("sess_1");
    expect(from1!.data).toEqual({ msg: "a" });

    const from2 = await store.dequeue("sess_2");
    expect(from2!.data).toEqual({ msg: "b" });

    const from1Again = await store.dequeue("sess_1");
    expect(from1Again!.data).toEqual({ msg: "c" });
  });

  it("lists non-empty Session queues once and clears one Session explicitly", async () => {
    await store.enqueue("sess_2", { type: "m", data: {}, sessionThreadId: "t" });
    await store.enqueue("sess_1", { type: "m", data: {}, sessionThreadId: "t" });
    await store.enqueue("sess_1", { type: "m", data: {}, sessionThreadId: "t" });

    expect(await store.listPendingSessionIds()).toEqual(["sess_1", "sess_2"]);
    await store.clear("sess_1");
    expect(await store.count("sess_1")).toBe(0);
    expect(await store.listPendingSessionIds()).toEqual(["sess_2"]);
  });
  async function completedInput(sessionId = "sess_1") {
    const input = await store.enqueue(sessionId, { type: "user.message", data: {}, sessionThreadId: "t" });
    const claim = (await store.claim(sessionId, "host-a", 60000))!;
    const log = new PgEventLogStore(harness.pool);
    const completion = await log.append(sessionId, {
      type: "session.turn_completed", data: { pendingEventId: input.id, turnId: "turn_1_a1" },
      sessionThreadId: "t", idempotencyKey: `pending:${input.id}:completed`,
      pendingFence: { eventId: input.id, ...claim },
    });
    return { input, claim, log, completion };
  }

  it("keeps the Session running between inputs and commits idle only with the final acknowledgement", async () => {
    await seedSession("sess_1", "running");
    const { input, claim, log } = await completedInput();
    const tail = await store.enqueue("sess_1", { type: "user.message", data: {}, sessionThreadId: "t" });
    expect(await store.ackCompletedTurn("sess_1", input.id, claim)).toEqual({ acknowledged: true });
    expect((await harness.pool.query("SELECT status FROM sessions WHERE id = 'sess_1'")).rows[0].status).toBe("running");
    expect((await log.getEvents("sess_1")).data.map(e => e.type)).toEqual(["session.turn_completed"]);

    const tailClaim = (await store.claim("sess_1", "host-b", 60000))!;
    await log.append("sess_1", { type: "session.turn_completed", data: { pendingEventId: tail.id, turnId: "turn_2_a1" },
      sessionThreadId: "t", idempotencyKey: `pending:${tail.id}:completed`, pendingFence: { eventId: tail.id, ...tailClaim } });
    const finished = await store.ackCompletedTurn("sess_1", tail.id, tailClaim);
    expect(finished).toMatchObject({ acknowledged: true, idleEvent: { type: "session.status_idle", seq: 3 } });
    expect(await store.count("sess_1")).toBe(0);
    expect((await harness.pool.query("SELECT status FROM sessions WHERE id = 'sess_1'")).rows[0].status).toBe("idle");
    expect((await log.getEvents("sess_1")).data.map(e => e.type)).toEqual([
      "session.turn_completed", "session.turn_completed", "session.status_idle",
    ]);
  });

  it("refuses acknowledgement before durable completion", async () => {
    await seedSession("sess_1", "running");
    const input = await store.enqueue("sess_1", { type: "user.message", data: {}, sessionThreadId: "t" });
    const claim = (await store.claim("sess_1", "host", 60000))!;
    await expect(store.ackCompletedTurn("sess_1", input.id, claim)).rejects.toThrow("completion marker");
    expect(await store.count("sess_1")).toBe(1);
    expect((await harness.pool.query("SELECT status FROM sessions WHERE id = 'sess_1'")).rows[0].status).toBe("running");
  });

  it("recovers a completed but unacknowledged Turn with a new owner and rejects the old owner", async () => {
    await seedSession("sess_1", "running");
    const { input, claim, log } = await completedInput();
    await store.releaseClaim("sess_1", input.id, claim);
    const next = (await store.claim("sess_1", "host-b", 60000))!;
    expect(await store.ackCompletedTurn("sess_1", input.id, claim)).toEqual({ acknowledged: false });
    expect((await log.getEvents("sess_1")).data).toHaveLength(1);
    expect(await store.ackCompletedTurn("sess_1", input.id, next)).toMatchObject({ acknowledged: true, idleEvent: { type: "session.status_idle" } });
    expect(await store.ackCompletedTurn("sess_1", input.id, next)).toEqual({ acknowledged: false });
    expect((await log.getEvents("sess_1")).data.map(e => e.type)).toEqual(["session.turn_completed", "session.status_idle"]);
  });

  it("never revives a terminated Session during completed-input acknowledgement", async () => {
    await seedSession("sess_1", "running");
    const { input, claim, log } = await completedInput();
    await harness.pool.query("UPDATE sessions SET status = 'terminated' WHERE id = 'sess_1'");
    expect(await store.ackCompletedTurn("sess_1", input.id, claim)).toEqual({ acknowledged: false });
    expect((await log.getEvents("sess_1")).data).toHaveLength(1);
  });

  it.skipIf(!process.env.PG_TEST_URL)("rolls back removal and status when the idle event cannot commit", async () => {
    await seedSession("sess_1", "running");
    const { input, claim, log } = await completedInput();
    await harness.pool.query(`CREATE FUNCTION reject_idle() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.type = 'session.status_idle' THEN RAISE EXCEPTION 'injected idle failure'; END IF; RETURN NEW; END $$`);
    await harness.pool.query("CREATE TRIGGER reject_idle BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION reject_idle()");
    await expect(store.ackCompletedTurn("sess_1", input.id, claim)).rejects.toThrow("injected idle failure");
    expect(await store.count("sess_1")).toBe(1);
    expect((await harness.pool.query("SELECT status FROM sessions WHERE id = 'sess_1'")).rows[0].status).toBe("running");
    expect((await log.getEvents("sess_1")).data).toHaveLength(1);
    await harness.pool.query("DROP TRIGGER reject_idle ON events");
    expect(await store.ackCompletedTurn("sess_1", input.id, claim)).toMatchObject({ acknowledged: true });
  });

  it.skipIf(!process.env.PG_TEST_URL)("observes ingress committed while completion waits for the Session lock", async () => {
    await seedSession("sess_1", "running");
    const { input, claim, log } = await completedInput();
    const ingress = await harness.pool.connect();
    try {
      await ingress.query("BEGIN");
      await ingress.query("SELECT id FROM sessions WHERE id = 'sess_1' FOR UPDATE");
      await ingress.query("INSERT INTO pending_events (id, session_id, type, data, session_thread_id, arrived_at) VALUES ('tail', 'sess_1', 'user.message', '{}', 't', clock_timestamp())");
      let settled = false;
      const ack = store.ackCompletedTurn("sess_1", input.id, claim).finally(() => { settled = true; });
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(settled).toBe(false);
      await ingress.query("COMMIT");
      expect(await ack).toEqual({ acknowledged: true });
      expect((await store.peek("sess_1"))?.id).toBe("tail");
      expect((await log.getEvents("sess_1")).data).toHaveLength(1);
    } finally { await ingress.query("ROLLBACK"); ingress.release(); }
  });

  it.skipIf(!process.env.PG_TEST_URL).each(["single", "batch"])(
    "serializes %s ingress behind a Session completion transaction", async (kind) => {
      await seedSession("sess_1", "running");
      const blocker = await harness.pool.connect();
      let accepting: Promise<unknown> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT id FROM sessions WHERE id = 'sess_1' FOR UPDATE");
        let accepted = false;
        const input = { type: "user.message", data: {}, sessionThreadId: "t" };
        accepting = (kind === "single" ? store.enqueue("sess_1", input) : store.enqueueBatchIfSessionActive("sess_1", [input]))
          .then(result => { accepted = true; return result; });
        await new Promise(resolve => setTimeout(resolve, 40));
        expect(accepted).toBe(false);
        expect(await store.count("sess_1")).toBe(0);
        await blocker.query("COMMIT");
        await accepting;
        expect(await store.count("sess_1")).toBe(1);
      } finally {
        await blocker.query("ROLLBACK"); blocker.release();
        await accepting;
      }
    },
  );

  it.skipIf(!process.env.PG_TEST_URL)("checks lease expiry after waiting for the Session lock", async () => {
    await seedSession("sess_1", "running");
    const { input, claim, log } = await completedInput();
    const blocker = await harness.pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM sessions WHERE id = 'sess_1' FOR UPDATE");
      const ack = store.ackCompletedTurn("sess_1", input.id, claim);
      await blocker.query("UPDATE pending_events SET claim_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [input.id]);
      await blocker.query("COMMIT");
      expect(await ack).toEqual({ acknowledged: false });
      expect(await store.count("sess_1")).toBe(1);
      expect((await log.getEvents("sess_1")).data).toHaveLength(1);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  });

});
