import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStores } from "@oma-server/store-memory";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import type { Adapter, AdapterInput, SessionEvent } from "@open-managed-agents/adapter-core";
import { SessionRouter } from "../src/session-router.js";

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

async function fixture(run: (input: AdapterInput) => AsyncIterable<SessionEvent>) {
  const stores = createMemoryStores();
  const agent = await stores.agentStore.create({ tenantId: "t", name: "test", model: "test", system: "test",
    runtime: "claude-code", sandbox: { enabled: false } });
  const session = await stores.sessionStore.create({ tenantId: "t", agentId: agent.id, agent, workspaceId: "ws" });
  const eventStreamHub = new InProcessEventStreamHub();
  const publish = vi.spyOn(eventStreamHub, "publish");
  const makeRouter = () => new SessionRouter({ ...stores, eventStreamHub, resolveAdapter: (): Adapter => ({ run }),
    pendingClaimRetryMinMs: 10 });
  const enqueue = (text: string) => stores.pendingEventStore.enqueue(session.id, {
    type: "user.message", data: { content: [{ type: "text", text }] }, sessionThreadId: "t",
  });
  return { ...stores, session, agent, makeRouter, enqueue, publish };
}

function reply(id: string): SessionEvent {
  return { type: "agent.message", id, timestamp: new Date().toISOString(), content: [{ type: "text", text: id }] };
}

describe("Session idle at queue boundaries", () => {
  it("completes each Turn while staying running until both queued inputs finish", async () => {
    let runs = 0;
    const f = await fixture(async function* () {
      expect(f.session.status).toBe("running");
      expect(f.publish.mock.calls.filter(([, e]) => e.type === "session.status_idle")).toHaveLength(0);
      yield reply(`reply-${++runs}`);
    });
    await f.enqueue("A"); await f.enqueue("B");
    await f.makeRouter().handleNewEvent(f.session.id, f.agent);
    expect(runs).toBe(2);
    expect(f.publish.mock.calls.map(([, e]) => e.type)).toEqual([
      "user.message", "session.status_running", "agent.message", "session.turn_completed",
      "user.message", "session.status_running", "agent.message", "session.turn_completed", "session.status_idle",
    ]);
    expect(f.session.status).toBe("idle");
    expect(await f.pendingEventStore.count(f.session.id)).toBe(0);
  });

  it("picks up input arriving after completion is persisted but before acknowledgement", async () => {
    let runs = 0;
    const f = await fixture(async function* () { yield reply(`reply-${++runs}`); });
    const router = f.makeRouter();
    const append = f.eventLogStore.append.bind(f.eventLogStore);
    let acceptedTail = false;
    vi.spyOn(f.eventLogStore, "append").mockImplementation(async (sessionId, event) => {
      const stored = await append(sessionId, event);
      if (event.type === "session.turn_completed" && !acceptedTail) {
        acceptedTail = true;
        await f.enqueue("B");
        await router.handleNewEvent(sessionId, f.agent);
      }
      return stored;
    });
    await f.enqueue("A");
    await router.handleNewEvent(f.session.id, f.agent);
    const types = f.publish.mock.calls.map(([, e]) => e.type);
    expect(runs).toBe(2);
    expect(types.filter(type => type === "session.status_idle")).toHaveLength(1);
    expect(types.at(-1)).toBe("session.status_idle");
  });

  it.each([false, true])("recovers completion before acknowledgement without rerunning it (tail: %s)", async (tail) => {
    vi.useFakeTimers();
    let runs = 0;
    const f = await fixture(async function* () { yield reply(`reply-${++runs}`); });
    await f.enqueue("A");
    if (tail) await f.enqueue("B");
    vi.spyOn(f.pendingEventStore, "ackCompletedTurn").mockImplementationOnce(async (sessionId, eventId, claim) => {
      // Simulate restart after the completed marker, with the old lease no longer live.
      await f.pendingEventStore.releaseClaim(sessionId, eventId, claim);
      throw new Error("host lost before acknowledgement");
    });
    await expect(f.makeRouter().handleNewEvent(f.session.id, f.agent)).rejects.toThrow("host lost");
    expect(f.session.status).toBe("running");
    expect(f.publish.mock.calls.filter(([, e]) => e.type === "session.status_idle")).toHaveLength(0);
    await f.makeRouter().handleNewEvent(f.session.id, f.agent);
    expect(runs).toBe(tail ? 2 : 1);
    expect(f.session.status).toBe("idle");
    const events = (await f.eventLogStore.getEvents(f.session.id, { limit: 100 })).data;
    expect(events.filter(e => e.type === "session.turn_completed")).toHaveLength(tail ? 2 : 1);
    expect(events.filter(e => e.type === "session.status_idle")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("session.status_idle");
  });

  it("interrupts only the current Turn and drains its tail without an idle transition", async () => {
    let runs = 0;
    let started!: () => void;
    const firstStarted = new Promise<void>(resolve => { started = resolve; });
    const f = await fixture(async function* (input) {
      runs++;
      if (runs === 1) {
        started();
        await new Promise<void>(resolve => input.signal!.addEventListener("abort", () => resolve(), { once: true }));
        return;
      }
      expect(f.publish.mock.calls.filter(([, e]) => e.type === "session.status_idle")).toHaveLength(0);
      yield reply("B");
    });
    await f.enqueue("A"); await f.enqueue("B");
    const router = f.makeRouter();
    const first = router.handleNewEvent(f.session.id, f.agent);
    await firstStarted;
    await router.requestInterrupt(f.session.id);
    await first;
    expect(await router.waitForIdle(2000)).toBe(true);
    expect(runs).toBe(2);
    const types = f.publish.mock.calls.map(([, e]) => e.type);
    expect(types.filter(type => type === "session.turn_aborted")).toHaveLength(1);
    expect(types.filter(type => type === "session.turn_completed")).toHaveLength(2);
    expect(types.filter(type => type === "session.status_idle")).toHaveLength(1);
    expect(types.at(-1)).toBe("session.status_idle");
  });

  it("does not declare idle when another Host holds the queue head", async () => {
    vi.useFakeTimers();
    const f = await fixture(async function* () { throw new Error("must not run"); });
    await f.enqueue("A");
    await f.pendingEventStore.claim(f.session.id, "other-host", 60000);
    await f.sessionStore.updateStatus(f.session.id, "running");
    await f.makeRouter().handleNewEvent(f.session.id, f.agent);
    expect(f.session.status).toBe("running");
    expect(f.publish).not.toHaveBeenCalled();
  });
});
