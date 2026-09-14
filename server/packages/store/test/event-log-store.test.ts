import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PgEventLogStore } from "../src/postgres/event-log-store.js";
import { PgPendingEventStore } from "../src/postgres/pending-event-store.js";
import { PendingEventClaimLostError } from "../src/errors.js";
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

  it("appends direct ingress only while the Session is active", async () => {
    await seedSession("sess_active");
    await expect(store.appendIfSessionActive("sess_active", {
      type: "user.define_outcome",
      data: { outcome: "ok" },
      sessionThreadId: "thread_1",
    })).resolves.toMatchObject({ seq: 1, type: "user.define_outcome" });

    await seedSession("sess_terminated", "terminated");
    await expect(store.appendIfSessionActive("sess_terminated", {
      type: "user.define_outcome",
      data: { outcome: "too late" },
      sessionThreadId: "thread_1",
    })).resolves.toBeNull();
    expect((await store.getEvents("sess_terminated")).data).toHaveLength(0);
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

  it("should make a caller-keyed append idempotent without consuming another seq", async () => {
    const first = await store.append("sess_1", {
      type: "user.message",
      data: { content: "first" },
      sessionThreadId: "thread_1",
      idempotencyKey: "pending:p1",
    });
    const retry = await store.append("sess_1", {
      type: "user.message",
      data: { content: "retry must not replace the committed event" },
      sessionThreadId: "thread_1",
      idempotencyKey: "pending:p1",
    });
    const next = await store.append("sess_1", {
      type: "agent.message",
      data: { content: "reply" },
      sessionThreadId: "thread_1",
    });

    expect(retry).toEqual(first);
    expect(next.seq).toBe(2);
    const events = await store.getEvents("sess_1", { limit: 10 });
    expect(events.data.map(({ seq, type }) => ({ seq, type }))).toEqual([
      { seq: 1, type: "user.message" },
      { seq: 2, type: "agent.message" },
    ]);
  });

  it("should converge concurrent retries with one idempotency key onto one Event", async () => {
    const retries = await Promise.all(
      Array.from({ length: 3 }, (_, i) => store.append("sess_1", {
        type: "user.message",
        data: { attempt: i },
        sessionThreadId: "thread_1",
        idempotencyKey: "pending:concurrent",
      })),
    );

    expect(new Set(retries.map((event) => event.seq))).toEqual(new Set([1]));
    expect((await store.getEvents("sess_1", { limit: 10 })).data).toHaveLength(1);
  });

  it("checks a pending owner+generation fence in the append transaction", async () => {
    await seedSession("sess_1");
    const pending = new PgPendingEventStore(harness.pool);
    const input = await pending.enqueue("sess_1", {
      type: "user.message",
      data: {},
      sessionThreadId: "thread_1",
    });
    const first = await pending.claim("sess_1", "host_a", 60_000);
    const fence = {
      eventId: input.id,
      ownerId: first!.ownerId,
      generation: first!.generation,
    };

    await expect(store.append("sess_1", {
      type: "session.status_running",
      data: {},
      sessionThreadId: "thread_1",
      pendingFence: fence,
    })).resolves.toMatchObject({ seq: 1 });

    await harness.pool.query(
      `UPDATE pending_events SET claim_expires_at = $2 WHERE id = $1`,
      [input.id, new Date(Date.now() - 1_000)],
    );
    const second = await pending.claim("sess_1", "host_b", 60_000);

    await expect(store.append("sess_1", {
      type: "agent.message",
      data: { text: "stale" },
      sessionThreadId: "thread_1",
      pendingFence: fence,
    })).rejects.toBeInstanceOf(PendingEventClaimLostError);
    await expect(store.append("sess_1", {
      type: "agent.message",
      data: { text: "current" },
      sessionThreadId: "thread_1",
      pendingFence: {
        eventId: input.id,
        ownerId: second!.ownerId,
        generation: second!.generation,
      },
    })).resolves.toMatchObject({ seq: 2 });
    expect((await store.getEvents("sess_1", { limit: 10 })).data).toHaveLength(2);
  });

  it("should return empty for a session with no events", async () => {
    const result = await store.getEvents("sess_empty");
    expect(result.data).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });

  it("aggregates durable model usage independently by Session and API key", async () => {
    await store.append("sess_1", {
      type: "span.model_request_end",
      data: {
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 40,
          cacheWriteTokens: 10,
        },
      },
      sessionThreadId: "thread_1",
      apiKeyId: "apikey_1",
    });
    await store.append("sess_1", {
      type: "span.model_request_end",
      data: {
        usage: {
          inputTokens: 50,
          outputTokens: 5,
          cacheReadTokens: 10,
          cacheWriteTokens: 0,
        },
      },
      sessionThreadId: "thread_1",
      apiKeyId: "apikey_2",
    });
    await store.append("sess_2", {
      type: "span.model_request_end",
      data: {
        usage: {
          inputTokens: 25,
          outputTokens: 3,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
      sessionThreadId: "thread_1",
      apiKeyId: "apikey_1",
    });

    await expect(store.getUsage({ sessionId: "sess_1" })).resolves.toEqual({
      inputTokens: 150,
      outputTokens: 25,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
      totalTokens: 175,
      cacheHitRate: 1 / 3,
    });
    await expect(store.getUsage({ apiKeyId: "apikey_1" })).resolves.toEqual({
      inputTokens: 125,
      outputTokens: 23,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      totalTokens: 148,
      cacheHitRate: 0.32,
    });
    const byKey = await store.getUsageByApiKeyIds(["apikey_1", "apikey_2", "apikey_empty"]);
    expect(byKey.get("apikey_1")).toEqual({
      inputTokens: 125,
      outputTokens: 23,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      totalTokens: 148,
      cacheHitRate: 0.32,
    });
    expect(byKey.get("apikey_2")).toEqual({
      inputTokens: 50,
      outputTokens: 5,
      cacheReadTokens: 10,
      cacheWriteTokens: 0,
      totalTokens: 55,
      cacheHitRate: 0.2,
    });
    expect(byKey.get("apikey_empty")).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      cacheHitRate: null,
    });
  });

  it("returns a null cache hit rate when no input tokens were recorded", async () => {
    await store.append("sess_1", {
      type: "span.model_request_end",
      data: {
        usage: {
          inputTokens: 0,
          outputTokens: 7,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
      sessionThreadId: "thread_1",
    });

    await expect(store.getUsage({ sessionId: "sess_1" })).resolves.toEqual({
      inputTokens: 0,
      outputTokens: 7,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 7,
      cacheHitRate: null,
    });
  });

  it("does not swallow a non-unique SQL failure merely because an idempotency key exists", async () => {
    const failure = Object.assign(new Error("statement timeout"), { code: "57014" });
    let lookedUpExisting = false;
    const client = {
      async query(sql: string) {
        if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] };
        if (sql.includes("SELECT * FROM events")) {
          lookedUpExisting = true;
          return { rows: [{ session_id: "s", seq: 1 }] };
        }
        throw failure;
      },
      release() {},
    };
    const faulting = new PgEventLogStore({
      connect: async () => client,
    } as never);

    await expect(faulting.append("s", {
      type: "agent.message",
      data: {},
      sessionThreadId: "t",
      idempotencyKey: "pending:p:event:0",
    })).rejects.toBe(failure);
    expect(lookedUpExisting).toBe(false);
  });

  it("revalidates a pending fence before returning a unique-conflict winner", async () => {
    const conflict = Object.assign(new Error("duplicate"), {
      code: "23505",
      constraint: "events_session_idempotency_key_uidx",
    });
    let pendingReads = 0;
    let lookedUpExisting = false;
    const client = {
      async query(sql: string) {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
          return { rows: [] };
        }
        if (sql.includes("FROM sessions")) return { rows: [{ status: "running" }] };
        if (sql.includes("FROM pending_events")) {
          pendingReads++;
          return { rows: pendingReads < 4 ? [{ id: "p" }] : [] };
        }
        if (sql.includes("INSERT INTO event_counters")) throw conflict;
        if (sql.includes("SELECT * FROM events")) {
          lookedUpExisting = true;
          return { rows: [{ session_id: "s", seq: 1 }] };
        }
        return { rows: [] };
      },
      release() {},
    };
    const faulting = new PgEventLogStore({
      connect: async () => client,
    } as never);

    await expect(faulting.append("s", {
      type: "agent.message",
      data: {},
      sessionThreadId: "t",
      idempotencyKey: "pending:p:event:0",
      pendingFence: { eventId: "p", ownerId: "old", generation: 1 },
    })).rejects.toBeInstanceOf(PendingEventClaimLostError);
    expect(pendingReads).toBe(4);
    expect(lookedUpExisting).toBe(false);
  });
});
