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

  it("tracks fenced lease generations for legacy Redis queues", async () => {
    const event = await store.enqueue("sess_1", {
      type: "user.message",
      data: {},
      sessionThreadId: "sthr_primary",
    });
    const first = await store.claim("sess_1", "host_a", 60_000);
    expect(first?.generation).toBe(1);
    expect(await store.claim("sess_1", "host_b", 60_000)).toBeNull();
    expect(await store.ack("sess_1", event.id)).toBe(false);
    expect(await store.releaseClaim("sess_1", event.id, first!)).toBe(true);

    const second = await store.claim("sess_1", "host_a", 60_000);
    expect(second?.generation).toBe(2);
    expect(await store.renewClaim("sess_1", event.id, first!, 60_000)).toBe(false);
    expect(await store.ack("sess_1", event.id, second!)).toBe(true);
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

  it("lists only the input no live attempt is executing (issue #114)", async () => {
    const first = await store.enqueue("sess_1", { type: "user.message", data: { n: 1 }, sessionThreadId: "t" });
    const second = await store.enqueue("sess_1", { type: "user.message", data: { n: 2 }, sessionThreadId: "t" });

    expect((await store.listUnclaimed("sess_1", 10)).map((e) => e.id)).toEqual([
      first.id,
      second.id,
    ]);

    // A live claim on the head means it is already promoted into the log.
    const claim = await store.claim("sess_1", "host_a", 60_000);
    expect(claim?.event.id).toBe(first.id);
    expect((await store.listUnclaimed("sess_1", 10)).map((e) => e.id)).toEqual([second.id]);

    // Released: no attempt owns it, so it is waiting input again.
    await store.releaseClaim("sess_1", first.id, claim!);
    expect((await store.listUnclaimed("sess_1", 10)).map((e) => e.id)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it("fills a full page of unclaimed input even when the head is claimed", async () => {
    const first = await store.enqueue("sess_1", { type: "m", data: { n: 1 }, sessionThreadId: "t" });
    const second = await store.enqueue("sess_1", { type: "m", data: { n: 2 }, sessionThreadId: "t" });
    await store.claim("sess_1", "host_a", 60_000);

    // limit 1 with a claimed head must still surface the entry behind it, not
    // return empty because the only page it read was the claimed one.
    expect((await store.listUnclaimed("sess_1", 1)).map((e) => e.id)).toEqual([second.id]);
    expect(first.id).not.toBe(second.id);
    await expect(store.listUnclaimed("sess_1", 0)).rejects.toThrow(RangeError);
  });

  it("keeps queues independent per session", async () => {
    await store.enqueue("sess_1", { type: "m", data: { msg: "a" }, sessionThreadId: "t" });
    await store.enqueue("sess_2", { type: "m", data: { msg: "b" }, sessionThreadId: "t" });
    expect(await store.count("sess_1")).toBe(1);
    expect(await store.count("sess_2")).toBe(1);
    expect((await store.dequeue("sess_1"))!.data).toEqual({ msg: "a" });
    expect((await store.dequeue("sess_2"))!.data).toEqual({ msg: "b" });
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
