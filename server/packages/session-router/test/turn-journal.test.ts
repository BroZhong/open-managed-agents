import { describe, expect, it } from "vitest";
import { createMemoryStores } from "@oma-server/store-memory";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { PendingEventClaimLostError } from "@oma-server/store";
import type { AgentMessageChunkEvent, AgentMessageEvent } from "@open-managed-agents/adapter-core";
import { TurnJournal, type JournalDelta, type TurnJournalOptions } from "../src/turn-journal.js";

interface Frame { event: string; seq?: number; data: Record<string, unknown> }

/** Collects the SSE frames a subscriber of the in-process hub receives. */
function watch(hub: InProcessEventStreamHub, sessionId: string): Frame[] {
  const reader = hub.subscribe(sessionId, { includeChunks: true }).stream.getReader();
  const frames: Frame[] = [];
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      const fields = Object.fromEntries(value.trim().split("\n").map(line => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]));
      frames.push({ event: fields.event, ...(fields.id === undefined ? {} : { seq: Number(fields.id) }), data: JSON.parse(fields.data) });
    }
  })();
  return frames;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const settle = () => sleep(0);
function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { opened, open };
}
const message = (id: string, text = id): AgentMessageEvent =>
  ({ id, timestamp: "2026-10-22T00:00:00.000Z", type: "agent.message", content: [{ type: "text", text }] });

const chunk = (id: string, text: string): AgentMessageChunkEvent =>
  ({ id, timestamp: "2026-10-22T00:00:00.000Z", type: "agent.message_chunk", text });

async function fixture() {
  const stores = createMemoryStores();
  const agent = await stores.agentStore.create({ tenantId: "t", name: "test", model: "test", system: "test", runtime: "pi-agent", sandbox: { enabled: false } });
  const session = await stores.sessionStore.create({ tenantId: "t", agentId: agent.id, agent, workspaceId: "ws" });
  await stores.pendingEventStore.enqueue(session.id, { type: "user.message", data: { content: [{ type: "text", text: "go" }] }, sessionThreadId: "sthr_primary" });
  const claim = (await stores.pendingEventStore.claim!(session.id, "runner-a", 30_000))!;
  const fence = { eventId: claim.event.id, ownerId: claim.ownerId, generation: claim.generation };
  const hub = new InProcessEventStreamHub();
  const frames = watch(hub, session.id);
  const lines: string[] = [];
  // The ports as the Router composes them: a fenced idempotent append, hub
  // publication and live Delta output.
  const options = (overrides: Partial<TurnJournalOptions> = {}): TurnJournalOptions => ({
    sessionId: session.id,
    attempt: fence.generation,
    append: (event, key) => stores.eventLogStore.append(session.id, { ...event, sessionThreadId: "sthr_primary", idempotencyKey: key, pendingFence: fence }),
    publish: stored => hub.publish(session.id, { type: stored.type, seq: stored.seq, data: stored.data }),
    outputDelta: delta => hub.publishChunk(session.id, delta),
    fromAdapter: event => ({ event: { type: event.type, data: { ...event, turnId: "turn_1" } }, key: `pending:${fence.eventId}:event:${event.id}` }),
    logger: { info: line => lines.push(line) },
    ...overrides,
  });
  const log = async () => (await stores.eventLogStore.getEvents(session.id, { limit: 100 })).data
    .map(stored => ({ seq: stored.seq, type: stored.type, id: (stored.data as { id?: string }).id }));
  const journal = (overrides?: Partial<TurnJournalOptions>) => {
    const created = new TurnJournal(options(overrides));
    created.bindTurn("turn_1");
    return created;
  };
  return { stores, session, fence, hub, frames, lines, log, options, journal };
}

describe("TurnJournal", () => {
  describe("durable writes", () => {
    it("writes recorded events only at flush, in record order with ascending seq", async () => {
      const f = await fixture();
      const journal = f.journal();
      journal.adapter.record(message("a"));
      journal.record({ type: "session.status_running", data: {} }, "status_running");
      journal.adapter.record(message("b"));
      await settle();
      expect(await f.log()).toEqual([]);

      await journal.adapter.flush();
      expect(await f.log()).toEqual([
        { seq: 1, type: "agent.message", id: "a" },
        { seq: 2, type: "session.status_running", id: undefined },
        { seq: 3, type: "agent.message", id: "b" },
      ]);
    });

    it("writes an event as it was when recorded", async () => {
      const f = await fixture();
      const journal = f.journal();
      const event = message("a", "recorded");
      journal.adapter.record(event);
      event.content[0] = { type: "text", text: "changed later" };
      await journal.adapter.flush();
      const [stored] = (await f.stores.eventLogStore.getEvents(f.session.id)).data;
      expect(stored.data).toMatchObject({ content: [{ type: "text", text: "recorded" }] });
    });

    it("resolves a flush only after every earlier record is written, serializing Adapter and owner flushes", async () => {
      const f = await fixture();
      const slow = f.options();
      const journal = f.journal({ append: async (event, key) => { await sleep(10); return slow.append(event, key); } });
      const seen: Record<string, Array<string | undefined>> = {};
      const observe = (name: string, flush: Promise<void>) => flush.then(async () => { seen[name] = (await f.log()).map(e => e.id ?? e.type); });

      journal.adapter.record(message("a"));
      const first = observe("first", journal.adapter.flush());
      await sleep(2); // a's append is in progress
      journal.record({ type: "session.status_running", data: {} }, "status_running");
      const second = observe("second", journal.flush());
      journal.adapter.record(message("b"));
      const third = observe("third", journal.adapter.flush());
      const fourth = observe("fourth", journal.flush());
      await Promise.all([first, second, third, fourth]);

      expect(seen.first).toContain("a");
      expect(seen.second).toEqual(expect.arrayContaining(["a", "session.status_running"]));
      expect(seen.third).toEqual(["a", "session.status_running", "b"]);
      expect(seen.fourth).toEqual(["a", "session.status_running", "b"]);
      await settle();
      expect(f.frames.map(frame => frame.seq)).toEqual([1, 2, 3]);
    });

    it("writes and publishes an event recorded more than once a single time", async () => {
      const f = await fixture();
      const journal = f.journal();
      journal.adapter.record(message("a"));
      journal.adapter.record(message("a"));
      journal.record({ type: "session.status_running", data: {} }, "status_running");
      await journal.adapter.flush();
      journal.adapter.record(message("a"));
      journal.record({ type: "session.status_running", data: {} }, "status_running");
      await journal.flush();

      expect(await f.log()).toEqual([
        { seq: 1, type: "agent.message", id: "a" },
        { seq: 2, type: "session.status_running", id: undefined },
      ]);
      await settle();
      expect(f.frames.map(frame => frame.seq)).toEqual([1, 2]);
    });

    it("rejects every flush after one write fails, even once the store recovers", async () => {
      const f = await fixture();
      const base = f.options();
      const outage = new Error("connection terminated");
      let failures = 1;
      const journal = f.journal({ append: async (event, key) => {
        if ((event.data as { id?: string }).id === "b" && failures-- > 0) throw outage;
        return base.append(event, key);
      } });
      journal.adapter.record(message("a"));
      journal.adapter.record(message("b"));
      journal.adapter.record(message("c"));
      await expect(journal.adapter.flush()).rejects.toBe(outage);

      expect(() => journal.adapter.record(message("d"))).not.toThrow();
      journal.record({ type: "session.turn_completed", data: {} }, "completed");
      await expect(journal.adapter.flush()).rejects.toBe(outage);
      await expect(journal.flush()).rejects.toBe(outage);
      expect(await f.log()).toEqual([{ seq: 1, type: "agent.message", id: "a" }]);
      await settle();
      expect(f.frames.map(frame => frame.seq)).toEqual([1]);
    });

    it("fails for good once its claim fence is lost", async () => {
      const f = await fixture();
      const journal = f.journal();
      journal.adapter.record(message("a"));
      await journal.adapter.flush();
      // Another Runner takes the input over under a newer generation.
      await f.stores.pendingEventStore.releaseClaim!(f.session.id, f.fence.eventId, f.fence);
      const takeover = (await f.stores.pendingEventStore.claim!(f.session.id, "runner-b", 30_000))!;
      expect(takeover.generation).toBeGreaterThan(f.fence.generation);

      journal.adapter.record(message("b"));
      await expect(journal.adapter.flush()).rejects.toBeInstanceOf(PendingEventClaimLostError);
      journal.record({ type: "session.turn_completed", data: {} }, "completed");
      await expect(journal.flush()).rejects.toBeInstanceOf(PendingEventClaimLostError);
      await expect(journal.adapter.flush()).rejects.toBeInstanceOf(PendingEventClaimLostError);
      expect(await f.log()).toEqual([{ seq: 1, type: "agent.message", id: "a" }]);
      // The new owner streams this Turn now.
      journal.adapter.delta(chunk("d1", "stale"), 0);
      await settle();
      expect(f.frames.map(frame => frame.event)).toEqual(["agent.message"]);
    });

    it("returns the row an owner's event was written as, also when an earlier attempt wrote it", async () => {
      const f = await fixture();
      const earlier = await f.stores.eventLogStore.append(f.session.id, { type: "user.message", data: { text: "go" },
        sessionThreadId: "sthr_primary", idempotencyKey: "pending:input", pendingFence: f.fence });
      const journal = new TurnJournal(f.options());
      journal.record({ type: "user.message", data: { text: "go" } }, "pending:input");
      journal.adapter.record(message("a"));
      expect(journal.written("pending:input")).toBeUndefined();
      await journal.flush();

      expect(journal.written("pending:input")).toEqual(earlier);
      expect(journal.written(`pending:${f.fence.eventId}:event:a`)).toBeUndefined();
    });

    it("names the Turn of its Deltas and flush logs once the owner binds it", async () => {
      const f = await fixture();
      const journal = new TurnJournal(f.options());
      journal.record({ type: "user.message", data: {} }, "pending:input");
      await journal.flush();
      journal.bindTurn("turn_7_a1");
      journal.adapter.delta(chunk("d1", "Hi"), 0);
      journal.record({ type: "session.status_running", data: {} }, "status_running");
      await journal.flush();
      await settle();

      expect(f.lines.map(line => JSON.parse(line).turnId)).toEqual([undefined, "turn_7_a1"]);
      expect(f.frames.find(frame => frame.seq === undefined)?.data).toMatchObject({ id: "d1", turnId: "turn_7_a1", blockIndex: 0 });
    });

    it("turns an event it cannot queue into a failed journal instead of throwing", async () => {
      const f = await fixture();
      const invalid = new Error("unsupported event");
      const journal = f.journal({ fromAdapter: event => { if (event.id === "bad") throw invalid; return f.options().fromAdapter(event); } });
      expect(() => journal.adapter.record(message("bad"))).not.toThrow();
      await expect(journal.adapter.flush()).rejects.toBe(invalid);
    });
  });

  describe("Adapter revocation", () => {
    it("writes what the Adapter recorded before revocation at the owner's next flush, and nothing after", async () => {
      const f = await fixture();
      const journal = f.journal();
      journal.adapter.record(message("a"));
      journal.adapter.record(message("b"));
      journal.revokeAdapter();

      journal.adapter.record(message("c"));
      journal.adapter.delta(chunk("d1", "late"), 0);
      journal.record({ type: "session.turn_aborted", data: { turnId: "turn_1" } }, "turn_aborted");
      await journal.flush();
      journal.adapter.record(message("e"));
      journal.record({ type: "session.turn_completed", data: {} }, "completed");
      await journal.flush();

      expect(await f.log()).toEqual([
        { seq: 1, type: "agent.message", id: "a" },
        { seq: 2, type: "agent.message", id: "b" },
        { seq: 3, type: "session.turn_aborted", id: undefined },
        { seq: 4, type: "session.turn_completed", id: undefined },
      ]);
      await settle();
      expect(f.frames.map(frame => frame.event)).toEqual(["agent.message", "agent.message", "session.turn_aborted", "session.turn_completed"]);
    });

    it("rejects the revoked Adapter's flush at once, while the owner's flush proceeds", async () => {
      const f = await fixture();
      const slow = f.options();
      const journal = f.journal({ append: async (event, key) => { await sleep(10); return slow.append(event, key); } });
      journal.adapter.record(message("a"));
      journal.revokeAdapter();
      journal.record({ type: "session.turn_completed", data: {} }, "completed");
      let ownerFlushed = false;
      const owner = journal.flush().then(() => { ownerFlushed = true; });

      await expect(journal.adapter.flush()).rejects.toThrow(/revoked/);
      expect(ownerFlushed).toBe(false);
      await owner;
      expect((await f.log()).map(e => e.id ?? e.type)).toEqual(["a", "session.turn_completed"]);
    });

    it("drops Deltas still queued for output when the Adapter is revoked", async () => {
      const f = await fixture();
      const live = f.options();
      const output = gate();
      const journal = f.journal({ outputDelta: async delta => { await output.opened; live.outputDelta(delta); } });
      journal.adapter.delta(chunk("d1", "a"), 0);
      journal.adapter.delta(chunk("d2", "b"), 0);
      await settle(); // d1 is being output, d2 waits behind it
      journal.revokeAdapter();
      output.open();
      await settle();
      expect(f.frames.map(frame => frame.data.id)).toEqual(["d1"]);
    });
  });

  describe("publication and Deltas", () => {
    it("publishes only the events it wrote, in seq order", async () => {
      const f = await fixture();
      const external = (type: string, key: string) => f.stores.eventLogStore.append(f.session.id,
        { type, data: {}, sessionThreadId: "sthr_primary", idempotencyKey: key, pendingFence: f.fence });
      await external("session.status_running", "status_running"); // an earlier attempt's write
      const journal = f.journal();
      journal.adapter.record(message("a"));
      await journal.adapter.flush();
      await external("subagent.instruction", "instruction"); // another writer's transaction
      journal.record({ type: "session.status_running", data: {} }, "status_running");
      journal.adapter.record(message("b"));
      await journal.flush();

      expect((await f.log()).map(e => [e.seq, e.id ?? e.type])).toEqual([
        [1, "session.status_running"], [2, "a"], [3, "subagent.instruction"], [4, "b"],
      ]);
      await settle();
      expect(f.frames.map(frame => frame.seq)).toEqual([2, 4]);
    });

    it("emits Deltas in call order at the Adapter's blockIndex, without waiting for them or writing them", async () => {
      const f = await fixture();
      const live = f.options();
      const slowFirst = gate();
      const journal = f.journal({ outputDelta: async delta => {
        if (delta.data.id === "d1") await slowFirst.opened;
        live.outputDelta(delta);
      } });
      journal.adapter.delta(chunk("d1", "Hel"), 4);
      journal.adapter.delta(chunk("d2", "lo"), 4);
      journal.adapter.record(message("a", "Hello"));
      await journal.adapter.flush();
      await settle();
      expect(f.frames.filter(frame => frame.seq === undefined)).toEqual([]);

      slowFirst.open();
      await settle();
      expect(f.frames.filter(frame => frame.seq === undefined)).toEqual([
        { event: "agent.message_chunk", data: expect.objectContaining({ id: "d1", text: "Hel", turnId: "turn_1", blockIndex: 4, attempt: 1 }) },
        { event: "agent.message_chunk", data: expect.objectContaining({ id: "d2", text: "lo", turnId: "turn_1", blockIndex: 4, attempt: 1 }) },
      ]);
      expect(await f.log()).toEqual([{ seq: 1, type: "agent.message", id: "a" }]);
    });

    it("tags every Delta with its attempt, so attempts sharing a Turn stay apart", async () => {
      const f = await fixture();
      const deltas: JournalDelta[] = [];
      const first = f.journal({ attempt: 1, outputDelta: delta => { deltas.push(delta); } });
      first.adapter.delta(chunk("d1", "Hel"), 3);
      await settle();
      first.revokeAdapter();
      const second = f.journal({ attempt: 2, outputDelta: delta => { deltas.push(delta); } });
      second.adapter.delta(chunk("d2", "Hello"), 3);
      await settle();

      expect(deltas.map(({ turnId, blockIndex, attempt, data }) => ({ turnId, blockIndex, attempt, id: data.id }))).toEqual([
        { turnId: "turn_1", blockIndex: 3, attempt: 1, id: "d1" },
        { turnId: "turn_1", blockIndex: 3, attempt: 2, id: "d2" },
      ]);
    });

    it("keeps writing durable events when Delta output fails", async () => {
      const f = await fixture();
      const live = f.options();
      let calls = 0;
      const journal = f.journal({ outputDelta: async delta => {
        calls++;
        if (calls === 1) throw new Error("redis unavailable");
        if (calls === 2) return Promise.reject(new Error("redis timeout"));
        live.outputDelta(delta);
      } });
      journal.adapter.delta(chunk("d1", "a"), 0);
      journal.adapter.record(message("a"));
      journal.adapter.delta(chunk("d2", "b"), 1);
      await journal.adapter.flush();
      journal.adapter.delta(chunk("d3", "c"), 2);
      journal.adapter.record(message("b"));
      await journal.adapter.flush();

      expect(await f.log()).toEqual([{ seq: 1, type: "agent.message", id: "a" }, { seq: 2, type: "agent.message", id: "b" }]);
      await settle();
      expect(f.frames.filter(frame => frame.seq === undefined).map(frame => frame.data.id)).toEqual(["d3"]);
    });
  });

  describe("flush log", () => {
    it("logs one structured line per flush that writes, with its duration, event count and bytes", async () => {
      const f = await fixture();
      const slow = f.options();
      const journal = f.journal({ append: async (event, key) => { await sleep(10); return slow.append(event, key); } });
      journal.record({ type: "span.a", data: { a: "é" } }, "a"); // {"a":"é"} is 10 UTF-8 bytes
      journal.record({ type: "span.b", data: { b: 1 } }, "b"); // {"b":1} is 7 bytes
      await journal.flush();
      await journal.adapter.flush(); // nothing new to write

      expect(f.lines).toHaveLength(1);
      const line = JSON.parse(f.lines[0]);
      expect(line).toEqual({ msg: "turn_journal_flush", sessionId: f.session.id, turnId: "turn_1", events: 2, bytes: 17, durationMs: expect.any(Number) });
      expect(line.durationMs).toBeGreaterThanOrEqual(15);
    });

    it("logs a failed flush with the events it wrote before the failure", async () => {
      const f = await fixture();
      const base = f.options();
      const journal = f.journal({ append: async (event, key) => {
        if (key === "b") throw new Error("connection terminated");
        return base.append(event, key);
      } });
      journal.record({ type: "span.a", data: { b: 1 } }, "a");
      journal.record({ type: "span.b", data: { b: 2 } }, "b");
      await expect(journal.flush()).rejects.toThrow("connection terminated");

      expect(f.lines.map(line => JSON.parse(line))).toEqual([expect.objectContaining({ events: 1, bytes: 7, error: "connection terminated" })]);
    });
  });
});
