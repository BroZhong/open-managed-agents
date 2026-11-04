import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createMemoryStores } from "@oma-server/store-memory";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import type { Adapter, SessionEvent } from "@open-managed-agents/adapter-core";
import { journalWriter } from "@open-managed-agents/adapter-mock";
import { SessionRouter } from "../src/session-router.js";

/**
 * How a Router claims Session heads (#325): a claim that takes nothing reads
 * and retries nothing more, because the holder of the head handles it, and
 * the pending scan claims the oldest heads first.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean> | boolean, timeout = 4000) {
  const start = Date.now();
  while (!await check()) { if (Date.now() - start > timeout) throw new Error("Timed out"); await sleep(5); }
}
const event = (type: string, data: object = {}) => ({ id: randomUUID(), timestamp: new Date().toISOString(), type, ...data }) as SessionEvent;

async function harness() {
  const stores = createMemoryStores();
  const agent = await stores.agentStore.create({ tenantId: "tenant", name: "Test", model: "test", system: "test", runtime: "mock", sandbox: { enabled: false } });
  const workspace = await stores.workspaceStore.create({ tenantId: "tenant" });
  const createSession = () => stores.sessionStore.create({ tenantId: "tenant", agentId: agent.id, agent, workspaceId: workspace.id });
  const ran: string[] = [];
  const adapter: Adapter = {
    async run(input) {
      ran.push(input.sessionId);
      await journalWriter(input)(event("agent.message", { content: [{ type: "text", text: "done" }] }));
      return "finished";
    },
  };
  const errors: unknown[] = [];
  const router = new SessionRouter({
    ...stores, eventStreamHub: new InProcessEventStreamHub(), resolveAdapter: () => adapter,
    pendingClaimOwnerId: "runner-a", pendingClaimRetryMinMs: 10, pendingClaimRetryMaxMs: 20,
    onDrainError: ({ error }) => errors.push(error),
  });
  const enqueue = (sessionId: string) => stores.pendingEventStore.enqueue(sessionId, {
    type: "user.message", data: { content: [{ type: "text", text: "work" }] }, sessionThreadId: "sthr_primary",
  });
  const idle = async (sessionId: string) => (await stores.sessionStore.getById(sessionId))?.status === "idle" &&
    await stores.pendingEventStore.count(sessionId) === 0;
  return { stores, agent, createSession, router, ran, errors, enqueue, idle };
}

describe("a Router's claims of Session heads (#325)", () => {
  it("a claim that takes nothing, as of a head another transaction holds, reads the queue no further and schedules no retry", async () => {
    const h = await harness();
    const session = await h.createSession();
    await h.enqueue(session.id);
    // The head is claimable, but the claim skips it: another transaction holds it.
    const attempts: string[] = [];
    h.stores.pendingEventStore.claim = async (sessionId) => { attempts.push(sessionId); return null; };
    const reads: string[] = [];
    const headClaimable = h.stores.pendingEventStore.headClaimable.bind(h.stores.pendingEventStore);
    h.stores.pendingEventStore.headClaimable = async (sessionId) => { reads.push(sessionId); return headClaimable(sessionId); };

    await h.router.handleNewEvent(session.id, h.agent);
    // Long enough for several claim retries, if one had been scheduled.
    await sleep(100);

    expect(attempts).toEqual([session.id]);
    expect(reads).toEqual([]);
    expect(await h.router.waitForIdle(0)).toBe(true);
    expect(h.errors).toEqual([]);
  });

  it("the pending scan claims the Sessions' heads in the order they arrived", async () => {
    const h = await harness();
    const sessions = [];
    for (let i = 0; i < 4; i++) sessions.push(await h.createSession());
    // Arrival order differs from creation (id) order.
    const arrival = [sessions[2], sessions[0], sessions[3], sessions[1]];
    for (const session of arrival) await h.enqueue(session.id);

    const recovery = await h.router.recoverPendingEvents();
    expect(recovery.recovered).toEqual(arrival.map((session) => session.id));
    for (const session of arrival) await until(() => h.idle(session.id));
    expect(h.ran).toEqual(arrival.map((session) => session.id));
    expect(h.errors).toEqual([]);
  });
});
