import { describe, it, expect, beforeEach } from "vitest";
import { RedisPendingEventStore } from "../src/pending-event-store.js";
import { FakeRedis } from "./fake-redis.js";

describe("RedisPendingEventStore", () => {
  let redis: FakeRedis;
  let store: RedisPendingEventStore;

  beforeEach(() => {
    redis = new FakeRedis();
    store = new RedisPendingEventStore(redis);
  });

  it("enqueue writes an event and dequeue returns it FIFO then removes", async () => {
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

    expect(await store.dequeue("sess_1")).toBeNull();
  });

  it("dequeue returns events in FIFO order", async () => {
    await store.enqueue("sess_1", { type: "m", data: { n: 1 }, sessionThreadId: "t" });
    await store.enqueue("sess_1", { type: "m", data: { n: 2 }, sessionThreadId: "t" });
    await store.enqueue("sess_1", { type: "m", data: { n: 3 }, sessionThreadId: "t" });

    expect((await store.dequeue("sess_1"))!.data).toEqual({ n: 1 });
    expect((await store.dequeue("sess_1"))!.data).toEqual({ n: 2 });
    expect((await store.dequeue("sess_1"))!.data).toEqual({ n: 3 });
  });

  it("peek returns the head without removing it", async () => {
    await store.enqueue("sess_1", { type: "user.message", data: { content: "first" }, sessionThreadId: "sthr_primary" });

    const peeked = await store.peek("sess_1");
    expect(peeked!.data).toEqual({ content: "first" });
    expect((await store.peek("sess_1"))!.id).toBe(peeked!.id);
    expect((await store.dequeue("sess_1"))!.id).toBe(peeked!.id);
  });

  it("dequeue returns null on empty queue", async () => {
    expect(await store.dequeue("sess_none")).toBeNull();
  });

  it("count reports the pending depth", async () => {
    expect(await store.count("sess_1")).toBe(0);
    await store.enqueue("sess_1", { type: "user.message", data: {}, sessionThreadId: "t" });
    await store.enqueue("sess_1", { type: "user.message", data: {}, sessionThreadId: "t" });
    expect(await store.count("sess_1")).toBe(2);
    await store.dequeue("sess_1");
    expect(await store.count("sess_1")).toBe(1);
  });

  it("keeps queues independent per session", async () => {
    await store.enqueue("sess_1", { type: "m", data: { msg: "a" }, sessionThreadId: "t" });
    await store.enqueue("sess_2", { type: "m", data: { msg: "b" }, sessionThreadId: "t" });
    expect(await store.count("sess_1")).toBe(1);
    expect(await store.count("sess_2")).toBe(1);
    expect((await store.dequeue("sess_1"))!.data).toEqual({ msg: "a" });
    expect((await store.dequeue("sess_2"))!.data).toEqual({ msg: "b" });
  });
});
