import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createMemoryStores } from "@oma-server/store-memory";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { InMemoryTurnStreamStore, type TurnStreamStore } from "@oma-server/redis";
import type { StoredEvent } from "@oma-server/store";
import type { Adapter, AdapterInput, AdapterRunResult, SessionEvent } from "@open-managed-agents/adapter-core";
import { journalWriter } from "@open-managed-agents/adapter-mock";
import { SessionRouter } from "../src/session-router.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const aborted = (signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) resolve();
  else signal.addEventListener("abort", () => resolve(), { once: true });
});
async function until(check: () => Promise<boolean> | boolean, timeout = 4000) {
  const start = Date.now();
  while (!await check()) { if (Date.now() - start > timeout) throw new Error("Timed out"); await sleep(5); }
}
const event = (type: string, data: object = {}) => ({ id: randomUUID(), timestamp: new Date().toISOString(), type, ...data }) as SessionEvent;
const turnIdOf = (stored: StoredEvent) => (stored.data as { turnId?: unknown } | null)?.turnId;

/** One attempt of the input: what the scripted runtime does with it, by attempt number. */
type Script = (input: AdapterInput, write: ReturnType<typeof journalWriter>, attempt: number) => Promise<AdapterRunResult | void>;

/**
 * A Session whose Runners share one durable store and one Redis stand-in. A
 * Runner is lost the way a killed process is: its lease stops renewing and it
 * never claims again, but what it committed stays.
 */
async function harness(script: Script) {
  const stores = createMemoryStores();
  const agent = await stores.agentStore.create({ tenantId: "tenant", name: "Test", model: "test", system: "test",
    runtime: "pi-agent", sandbox: { enabled: false } });
  const workspace = await stores.workspaceStore.create({ tenantId: "tenant" });
  const session = await stores.sessionStore.create({ tenantId: "tenant", agentId: agent.id, agent, workspaceId: workspace.id });
  /** The Turn each attempt was handed, in attempt order. */
  const attempts: string[] = [];
  const adapter: Adapter = { async run(input) {
    attempts.push(input.turnId);
    return await script(input, journalWriter(input), attempts.length) ?? "finished";
  } };
  const lost = new Set<string>();
  const renew = stores.pendingEventStore.renewClaim.bind(stores.pendingEventStore);
  stores.pendingEventStore.renewClaim = async (sessionId, eventId, claim, leaseMs) =>
    lost.has(claim.ownerId) ? false : renew(sessionId, eventId, claim, leaseMs);
  const claim = stores.pendingEventStore.claim.bind(stores.pendingEventStore);
  stores.pendingEventStore.claim = async (sessionId, ownerId, leaseMs) =>
    lost.has(ownerId) ? null : claim(sessionId, ownerId, leaseMs);
  const turns = new InMemoryTurnStreamStore();
  const errors: unknown[] = [];
  const hub = new InProcessEventStreamHub();
  const runner = (ownerId: string, turnStreamStore: TurnStreamStore = turns) => new SessionRouter({
    ...stores, eventStreamHub: hub, turnStreamStore, resolveAdapter: () => adapter,
    pendingClaimOwnerId: ownerId, pendingClaimLeaseMs: 100, pendingClaimRenewIntervalMs: 30,
    pendingClaimRetryMinMs: 10, pendingClaimRetryMaxMs: 20,
    onDrainError: ({ error }) => errors.push(error),
  });
  const enqueue = (text: string) => stores.pendingEventStore.enqueue(session.id, {
    type: "user.message", data: { content: [{ type: "text", text }] }, sessionThreadId: "sthr_primary",
  });
  const log = async () => (await stores.eventLogStore.getEvents(session.id, { limit: 1000 })).data;
  const ofType = async (type: string) => (await log()).filter((stored) => stored.type === type);
  /** Lose a Runner, wait for it to stop, then for its lease to run out. */
  const lose = async (ownerId: string, drain: Promise<void>) => {
    lost.add(ownerId);
    await drain;
    await sleep(120);
  };
  /** A replacement Runner takes the Session over and drains it. */
  const takeOver = async (ownerId: string) => {
    const replacement = runner(ownerId);
    await replacement.handleNewEvent(session.id, agent);
    expect(await replacement.waitForIdle(4000)).toBe(true);
  };
  /** Every Turn the log's events name. */
  const namedTurns = async () => [...new Set((await log()).map(turnIdOf).filter((turnId) => turnId !== undefined))];
  return { stores, agent, session, attempts, turns, errors, lost, runner, enqueue, log, ofType, lose, takeOver, namedTurns };
}

/** The first attempt commits a tool call and streams the start of a message, then runs until it is stopped. */
const lostMidTool: Script = async (input, write, attempt) => {
  if (attempt > 1) throw new Error("A Turn with committed output is not run again");
  await write(event("agent.tool_use", { toolUseId: "call_1", name: "bash", input: { command: "sleep 600" } }));
  await write(event("agent.message_stream_start"));
  await write(event("agent.message_chunk", { text: "Hel" }));
  await aborted(input.signal!);
};

describe("every attempt of an input continues the Turn its first attempt started", () => {
  it("A6 partial output: the repair, the recovery error and the completion name the lost attempt's Turn", async () => {
    const h = await harness(lostMidTool);
    await h.enqueue("A");
    const first = h.runner("runner-a");
    const draining = first.handleNewEvent(h.session.id, h.agent);
    await until(async () => (await h.ofType("agent.tool_use")).length === 1);
    await h.lose("runner-a", draining);

    await h.takeOver("runner-b");

    expect(h.attempts).toEqual(["turn_1_a1"]);
    const log = await h.log();
    // One Turn: every event of the input names the Turn its first attempt started.
    expect(await h.namedTurns()).toEqual(["turn_1_a1"]);
    const [call] = await h.ofType("agent.tool_use");
    const [repair] = await h.ofType("agent.tool_result");
    // The repair pairs with the call it answers, in the same Turn.
    expect(repair.data).toMatchObject({ toolUseId: "call_1", isError: true, turnId: turnIdOf(call) });
    expect((await h.ofType("session.error")).map((stored) => stored.data)).toEqual([
      { turnId: "turn_1_a1", error: expect.objectContaining({ code: "recovery_partial_turn_aborted" }) }]);
    expect((await h.ofType("session.turn_completed")).map((stored) => stored.data))
      .toEqual([expect.objectContaining({ turnId: "turn_1_a1" })]);
    expect(log.at(-1)?.type).toBe("session.status_idle");
  });

  it("A12 a terminal event the lost attempt committed: the repair and the completion name its Turn", async () => {
    const h = await harness(async (_input, write) => {
      await write(event("agent.tool_use", { toolUseId: "call_1", name: "bash", input: {} }));
      throw new Error("runtime failed");
    });
    // The attempt records its error, then is lost before its completion marker.
    const append = h.stores.eventLogStore.append.bind(h.stores.eventLogStore);
    vi.spyOn(h.stores.eventLogStore, "append").mockImplementation(async (sessionId, input) => {
      if (input.type === "session.turn_completed" && h.attempts.length === 1 && !h.lost.has("runner-a")) {
        h.lost.add("runner-a");
        throw new Error("Runner lost before its completion marker");
      }
      return append(sessionId, input);
    });
    await h.enqueue("A");
    await h.lose("runner-a", h.runner("runner-a").handleNewEvent(h.session.id, h.agent));
    expect(await h.ofType("session.turn_completed")).toEqual([]);

    await h.takeOver("runner-b");

    expect(h.attempts).toEqual(["turn_1_a1"]);
    expect(await h.namedTurns()).toEqual(["turn_1_a1"]);
    expect((await h.ofType("agent.tool_result")).map((stored) => stored.data))
      .toEqual([expect.objectContaining({ toolUseId: "call_1", isError: true, turnId: "turn_1_a1" })]);
    expect((await h.ofType("session.error")).map((stored) => (stored.data as { error: { code: string } }).error.code)).toEqual(["adapter_error"]);
    expect((await h.ofType("session.turn_completed")).map((stored) => stored.data))
      .toEqual([expect.objectContaining({ turnId: "turn_1_a1" })]);
  });

  it("A3 a rerun of an input no attempt named: the rerun's Turn is the only one", async () => {
    const h = await harness(async (input, write, attempt) => {
      if (attempt === 1) { await aborted(input.signal!); return; }
      await write(event("agent.message", { content: [{ type: "text", text: "done" }] }));
    });
    await h.enqueue("A");
    const first = h.runner("runner-a");
    const draining = first.handleNewEvent(h.session.id, h.agent);
    await until(() => h.attempts.length === 1);
    await h.lose("runner-a", draining);

    await h.takeOver("runner-b");

    // The lost attempt committed nothing that names its Turn; the rerun's Turn is the input's.
    expect(h.attempts).toEqual(["turn_1_a1", "turn_1_a2"]);
    expect(await h.namedTurns()).toEqual(["turn_1_a2"]);
    expect((await h.ofType("session.turn_completed")).map((stored) => stored.data))
      .toEqual([expect.objectContaining({ turnId: "turn_1_a2" })]);
    expect(await h.ofType("session.error")).toEqual([]);
  });
});
