/**
 * Runners sharing one store, in fake time at the real lease defaults (30 s
 * lease, 10 s renew interval): how often a running Turn touches PostgreSQL,
 * and how quickly the Runners still react (#234's database-load fixes).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStores } from "@oma-server/store-memory";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import type { Adapter } from "@open-managed-agents/adapter-core";
import { SessionRouter, type SessionRouterDeps } from "../src/session-router.js";
import { acceptInterrupt } from "./accept-interrupt.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  // The Router's TurnJournal logs one line per flush.
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Advance fake time in small steps, letting every promise chain settle in between. */
async function advance(ms: number, step = 10): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    vi.advanceTimersByTime(Math.min(step, ms - elapsed));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** A Turn that runs until it is aborted or released. */
function longTurn() {
  const aborts: number[] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let runs = 0;
  const adapter: Adapter = {
    async run(input) {
      runs++;
      await new Promise<void>((resolve) => {
        input.signal?.addEventListener("abort", () => { aborts.push(Date.now()); resolve(); }, { once: true });
        void released.then(resolve);
      });
      return "finished";
    },
  };
  return { adapter, aborts, release, runs: () => runs };
}

async function fleet() {
  const stores = createMemoryStores();
  const turn = longTurn();
  const agent = await stores.agentStore.create({ tenantId: "tenant", name: "Test", model: "test", system: "test", runtime: "mock", sandbox: { enabled: false } });
  const workspace = await stores.workspaceStore.create({ tenantId: "tenant" });
  const session = await stores.sessionStore.create({ tenantId: "tenant", agentId: agent.id, agent, workspaceId: workspace.id });
  const claims: Array<{ owner: string; at: number; claimed: boolean }> = [];
  const renewals: Array<{ owner: string; at: number }> = [];
  const crashed = new Set<string>();
  const pending = stores.pendingEventStore;
  const claim = pending.claim.bind(pending);
  pending.claim = async (sessionId, owner, leaseMs) => {
    const at = Date.now();
    const result = await claim(sessionId, owner, leaseMs);
    claims.push({ owner, at, claimed: Boolean(result) });
    return result;
  };
  const renew = pending.renewClaim.bind(pending);
  pending.renewClaim = async (sessionId, eventId, ref, leaseMs) => {
    // A crashed Runner never renews, releases or acknowledges again.
    if (crashed.has(ref.ownerId)) return new Promise(() => {});
    renewals.push({ owner: ref.ownerId, at: Date.now() });
    return renew(sessionId, eventId, ref, leaseMs);
  };
  const errors: unknown[] = [];
  const makeRouter = (owner: string, deps: Partial<SessionRouterDeps> = {}) => new SessionRouter({
    ...stores, eventStreamHub: new InProcessEventStreamHub(), resolveAdapter: () => turn.adapter,
    pendingClaimOwnerId: owner, wakeSession: () => {}, onDrainError: ({ error }) => errors.push(error), ...deps,
  });
  const send = (text = "go") => pending.enqueue(session.id, {
    type: "user.message", data: { content: [{ type: "text", text }] }, sessionThreadId: "sthr_primary",
  });
  const completedTurns = async () => (await stores.eventLogStore.getEvents(session.id, { limit: 1000 })).data
    .filter((event) => event.type === "session.turn_completed").length;
  return { stores, turn, agent, session, claims, renewals, crashed, errors, makeRouter, send, completedTurns };
}

describe("Runners sharing one store", () => {
  it("renews a running Turn's claim once per renew interval", async () => {
    const f = await fleet();
    const owner = f.makeRouter("runner-a");
    await f.send();
    void owner.handleNewEvent(f.session.id, f.agent);
    await advance(100);
    expect(f.turn.runs()).toBe(1);

    const before = f.renewals.length;
    await advance(60_000);
    expect(f.renewals.length - before).toBe(6);

    f.turn.release();
    await advance(100);
    expect(await f.completedTurns()).toBe(1);
    expect(f.errors).toEqual([]);
  });

  it("sees an Interrupt accepted on another Host at once when the check hint arrives", async () => {
    const f = await fleet();
    const owner = f.makeRouter("runner-a");
    await f.send();
    void owner.handleNewEvent(f.session.id, f.agent);
    await advance(1_500);

    const requestedAt = Date.now();
    // The API accepts it; the hint reaches the owner as Redis delivers it in production.
    expect(await acceptInterrupt(f.stores.pendingEventStore, f.session.id, owner)).toBe(true);
    await advance(100);
    expect(f.turn.aborts).toHaveLength(1);
    expect(f.turn.aborts[0] - requestedAt).toBeLessThan(50);
    await advance(3_000);
    expect(await f.completedTurns()).toBe(1);
    expect(f.errors).toEqual([]);
  });

  it("sees an Interrupt within one renew interval when its hint is lost", async () => {
    const f = await fleet();
    const owner = f.makeRouter("runner-a");
    await f.send();
    void owner.handleNewEvent(f.session.id, f.agent);
    await advance(1_500);

    const requestedAt = Date.now();
    expect(await acceptInterrupt(f.stores.pendingEventStore, f.session.id)).toBe(true);
    await advance(10_100);
    expect(f.turn.aborts).toHaveLength(1);
    expect(f.turn.aborts[0] - requestedAt).toBeLessThanOrEqual(10_000);
    await advance(3_000);
    expect(await f.completedTurns()).toBe(1);
    expect(f.errors).toEqual([]);
  });

  it("makes no claim attempt from another Runner while the owner's lease is live", async () => {
    const f = await fleet();
    const owner = f.makeRouter("runner-a");
    const other = f.makeRouter("runner-b");
    await f.send();
    void owner.handleNewEvent(f.session.id, f.agent);
    await advance(100);
    // The other Runner scans PostgreSQL every 5 s, as RunnerDispatch does.
    const scan = setInterval(() => void other.recoverPendingEvents(), 5_000);
    // Input queued behind the running Turn wakes every Runner once.
    await f.send("queued behind the Turn");
    void other.handleNewEvent(f.session.id, f.agent);
    await advance(60_000);
    clearInterval(scan);

    // The wake's one attempt; no retry timer and no scan claims the owned head.
    expect(f.claims.filter((claim) => claim.owner === "runner-b")).toHaveLength(1);
    expect(await other.waitForIdle(0)).toBe(true);

    // The owner drains its own queue.
    f.turn.release();
    await advance(100);
    expect(await f.completedTurns()).toBe(2);
    expect(f.claims.filter((claim) => claim.claimed).map((claim) => claim.owner)).toEqual(["runner-a", "runner-a"]);
    expect(f.errors).toEqual([]);
  });

  it("takes a crashed owner's Turn over within the lease plus one scan", async () => {
    const f = await fleet();
    const owner = f.makeRouter("runner-a");
    const other = f.makeRouter("runner-b");
    await f.send();
    void owner.handleNewEvent(f.session.id, f.agent);
    await advance(100);
    const scan = setInterval(() => void other.recoverPendingEvents(), 5_000);
    await advance(2_000);

    // The owner's process stops: its lease is never renewed or released.
    f.crashed.add("runner-a");
    const crashedAt = Date.now();
    await advance(40_000);
    clearInterval(scan);

    const takeover = f.claims.find((claim) => claim.owner === "runner-b" && claim.claimed);
    expect(takeover).toBeDefined();
    expect(takeover!.at - crashedAt).toBeLessThanOrEqual(30_000 + 5_000);
    // Before the lease expired the other Runner did not try at all.
    expect(f.claims.filter((claim) => claim.owner === "runner-b")).toHaveLength(1);
    expect(f.turn.runs()).toBe(2);
  });

  it("E8 two Runners race for an expired claim: exactly one wins and the loser stays quiet", async () => {
    const f = await fleet();
    const owner = f.makeRouter("runner-a");
    const others = [f.makeRouter("runner-b"), f.makeRouter("runner-c")];
    await f.send();
    void owner.handleNewEvent(f.session.id, f.agent);
    await advance(100);
    f.crashed.add("runner-a");
    await advance(30_000);

    // Both reach the expired head at once, as a wake or simultaneous scans do.
    for (const other of others) void other.handleNewEvent(f.session.id, f.agent);
    const scan = setInterval(() => { for (const other of others) void other.recoverPendingEvents(); }, 5_000);
    await advance(30_000);
    clearInterval(scan);

    const takeovers = f.claims.filter((claim) => claim.owner !== "runner-a" && claim.claimed);
    expect(takeovers).toHaveLength(1);
    const loser = takeovers[0].owner === "runner-b" ? "runner-c" : "runner-b";
    // One contended attempt in the race; no retry and no scan of the winner's live head after it.
    expect(f.claims.filter((claim) => claim.owner === loser)).toEqual([expect.objectContaining({ claimed: false })]);
    expect(f.turn.runs()).toBe(2);
  });
});
