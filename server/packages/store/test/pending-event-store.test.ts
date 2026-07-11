import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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

  async function seedSession(id: string, status: "idle" | "terminated" = "idle") {
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
    });

    const event = await store.dequeue("sess_1");
    expect(event).not.toBeNull();
    expect(event!.sessionId).toBe("sess_1");
    expect(event!.type).toBe("user.message");
    expect(event!.data).toEqual({ content: "hello" });
    expect(event!.sessionThreadId).toBe("sthr_primary");
    expect(event!.arrivedAt).toBeInstanceOf(Date);
    expect(event!.id).toBeDefined();

    const next = await store.dequeue("sess_1");
    expect(next).toBeNull();
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
});
