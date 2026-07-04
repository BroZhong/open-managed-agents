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
});
