import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PgEventLogStore } from "../src/postgres/event-log-store.js";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";

describe("PgEventLogStore", () => {
  let harness: PgTestHarness;
  let store: PgEventLogStore;

  beforeAll(async () => {
    harness = await createPgTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
    store = new PgEventLogStore(harness.pool);
  });

  it("should append events with monotonically increasing seq", async () => {
    const e1 = await store.append("sess_1", {
      type: "user_message",
      data: { content: "hello" },
      sessionThreadId: "thread_1",
    });
    const e2 = await store.append("sess_1", {
      type: "assistant_message",
      data: { content: "hi" },
      sessionThreadId: "thread_1",
    });
    const e3 = await store.append("sess_1", {
      type: "user_message",
      data: { content: "bye" },
      sessionThreadId: "thread_1",
    });

    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e3.seq).toBe(3);
    expect(e1.sessionId).toBe("sess_1");
    expect(e1.type).toBe("user_message");
    expect(e1.ts).toBeInstanceOf(Date);
    expect(e1.data).toEqual({ content: "hello" });
  });

  it("should maintain independent seq per session", async () => {
    const e1 = await store.append("sess_1", {
      type: "msg",
      data: {},
      sessionThreadId: "thread_1",
    });
    const e2 = await store.append("sess_2", {
      type: "msg",
      data: {},
      sessionThreadId: "thread_2",
    });

    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(1);
  });

  it("should get events with pagination", async () => {
    for (let i = 0; i < 5; i++) {
      await store.append("sess_1", {
        type: "msg",
        data: { i },
        sessionThreadId: "thread_1",
      });
    }

    const page1 = await store.getEvents("sess_1", { limit: 3 });
    expect(page1.data).toHaveLength(3);
    expect(page1.hasMore).toBe(true);
    expect(page1.data[0].seq).toBe(1);
    expect(page1.data[2].seq).toBe(3);

    const page2 = await store.getEvents("sess_1", { afterSeq: 3, limit: 3 });
    expect(page2.data).toHaveLength(2);
    expect(page2.hasMore).toBe(false);
    expect(page2.data[0].seq).toBe(4);
    expect(page2.data[1].seq).toBe(5);
  });

  it("should assign a unique seq per (sessionId) even under concurrent appends", async () => {
    const events = await Promise.all([
      store.append("sess_1", { type: "msg", data: { i: 1 }, sessionThreadId: "t1" }),
      store.append("sess_1", { type: "msg", data: { i: 2 }, sessionThreadId: "t1" }),
      store.append("sess_1", { type: "msg", data: { i: 3 }, sessionThreadId: "t1" }),
    ]);

    const seqs = events.map((e) => e.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it("should return empty for a session with no events", async () => {
    const result = await store.getEvents("sess_empty");
    expect(result.data).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });
});
