import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { MongoEventLogStore } from "../src/mongodb/event-log-store.js";

describe("MongoEventLogStore", () => {
  let mongod: MongoMemoryServer;
  let client: MongoClient;
  let store: MongoEventLogStore;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    client = new MongoClient(mongod.getUri());
    await client.connect();
  });

  afterAll(async () => {
    await client.close();
    await mongod.stop();
  });

  beforeEach(async () => {
    const db = client.db("test_events");
    await db.dropDatabase();
    store = new MongoEventLogStore(db);
    await store.ensureIndexes();
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

  it("should enforce unique (sessionId, seq) index", async () => {
    // This is implicitly tested by the monotonic increment, but let's verify
    // the index prevents duplicates by checking seq values
    const events = await Promise.all([
      store.append("sess_1", { type: "msg", data: { i: 1 }, sessionThreadId: "t1" }),
      store.append("sess_1", { type: "msg", data: { i: 2 }, sessionThreadId: "t1" }),
      store.append("sess_1", { type: "msg", data: { i: 3 }, sessionThreadId: "t1" }),
    ]);

    const seqs = events.map((e) => e.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2, 3]);
  });
});
