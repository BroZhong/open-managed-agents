import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createMemoryStores } from "@oma-server/store-memory";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import type { Adapter, AdapterInput, SessionEvent } from "@open-managed-agents/adapter-core";
import { journalWriter } from "@open-managed-agents/adapter-mock";
import { SessionRouter } from "../src/session-router.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const aborted = (signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) resolve();
  else signal.addEventListener("abort", () => resolve(), { once: true });
});
async function until(check: () => Promise<boolean>, timeout = 4000) {
  const start = Date.now();
  while (!await check()) { if (Date.now() - start > timeout) throw new Error("Timed out"); await sleep(10); }
}
const event = (type: string, data: object = {}) => ({ id: randomUUID(), timestamp: new Date().toISOString(), type, ...data }) as SessionEvent;
const inputText = (input: AdapterInput) => input.message.content.map((block) => block.type === "text" ? block.text : "").join("");

/** What the scripted model does with one input: a model request per call, then an answer, a running tool or nothing. */
type Script = (input: AdapterInput, write: ReturnType<typeof journalWriter>) => Promise<void>;

/**
 * A Session whose Runners all share one durable store, driven by a scripted
 * Adapter that counts its model requests per input. A Runner is lost the way
 * a killed process is: its lease stops renewing and it never claims again,
 * but what it committed stays.
 */
async function harness(scripts: Record<string, Script>) {
  const stores = createMemoryStores();
  const agent = await stores.agentStore.create({ tenantId: "tenant", name: "Test", model: "test", system: "test",
    runtime: "pi-agent", sandbox: { enabled: false } });
  const workspace = await stores.workspaceStore.create({ tenantId: "tenant" });
  const session = await stores.sessionStore.create({ tenantId: "tenant", agentId: agent.id, agent, workspaceId: workspace.id });
  const requests: string[] = [];
  const adapter: Adapter = { async run(input) {
    const text = inputText(input);
    requests.push(text);
    await scripts[text]!(input, journalWriter(input));
    return "finished";
  } };
  const lost = new Set<string>();
  const renew = stores.pendingEventStore.renewClaim.bind(stores.pendingEventStore);
  stores.pendingEventStore.renewClaim = async (sessionId, eventId, claim, leaseMs) =>
    lost.has(claim.ownerId) ? false : renew(sessionId, eventId, claim, leaseMs);
  const claim = stores.pendingEventStore.claim.bind(stores.pendingEventStore);
  stores.pendingEventStore.claim = async (sessionId, ownerId, leaseMs) =>
    lost.has(ownerId) ? null : claim(sessionId, ownerId, leaseMs);
  // A lost Runner reports its lost lease; that is the loss, not news.
  const errors: unknown[] = [];
  const hub = new InProcessEventStreamHub();
  const runner = (ownerId: string) => new SessionRouter({
    ...stores, eventStreamHub: hub, resolveAdapter: () => adapter,
    pendingClaimOwnerId: ownerId, pendingClaimLeaseMs: 100, pendingClaimRenewIntervalMs: 30,
    pendingClaimRetryMinMs: 10, pendingClaimRetryMaxMs: 20,
    onDrainError: ({ error }) => errors.push(error),
  });
  const enqueue = (text: string) => stores.pendingEventStore.enqueue(session.id, {
    type: "user.message", data: { content: [{ type: "text", text }] }, sessionThreadId: "sthr_primary",
  });
  const log = async () => (await stores.eventLogStore.getEvents(session.id, { limit: 1000 })).data;
  const ofType = async (type: string) => (await log()).filter((stored) => stored.type === type);
  /** Wait for a lost Runner to stop, then for its lease to run out. */
  const expire = async (drain: Promise<void>) => {
    await drain;
    await sleep(120);
  };
  /** Lose a Runner and let its lease run out. */
  const lose = async (ownerId: string, drain: Promise<void>) => {
    lost.add(ownerId);
    await expire(drain);
  };
  /** A replacement Runner takes the Session over and drains it. */
  const takeOver = async (ownerId: string) => {
    const replacement = runner(ownerId);
    await replacement.handleNewEvent(session.id, agent);
    expect(await replacement.waitForIdle(4000)).toBe(true);
    return replacement;
  };
  /** The Turn each completion names, by the input it completed. */
  const completions = async () => (await ofType("session.turn_completed"))
    .map((stored) => stored.data as { pendingEventId: string; turnId: string });
  return { stores, agent, session, requests, runner, enqueue, log, ofType, expire, lose, takeOver, completions, lost };
}

/** A model request that starts a long tool, which runs until the Turn is stopped. */
const runsTool: Script = async (input, write) => {
  await write(event("agent.tool_use", { toolUseId: "call_1", name: "bash", input: { command: "sleep 600" } }));
  await aborted(input.signal!);
};
const answers: Script = async (input, write) => { await write(event("agent.message", { content: [{ type: "text", text: `${inputText(input)} done` }] })); };

describe("an Interrupt accepted before its Runner was lost", () => {
  it("D1/D5 ends the Turn as an Interrupted Turn on takeover with no new model request, then runs the queued input", async () => {
    const h = await harness({ A: runsTool, B: answers });
    const a = await h.enqueue("A");
    const b = await h.enqueue("B");
    const first = h.runner("runner-a");
    const draining = first.handleNewEvent(h.session.id, h.agent);
    await until(async () => (await h.ofType("agent.tool_use")).length === 1);

    // The user presses stop and the Runner dies before it ever sees the Interrupt.
    h.lost.add("runner-a");
    expect(await first.requestInterrupt(h.session.id)).toEqual({ requested: true, interrupted: false });
    await h.lose("runner-a", draining);
    expect(await h.ofType("session.turn_aborted")).toEqual([]);
    expect(await h.ofType("session.turn_completed")).toEqual([]);

    await h.takeOver("runner-b");

    expect(h.requests).toEqual(["A", "B"]);
    const log = await h.log();
    const repairs = log.filter((stored) => stored.type === "agent.tool_result");
    expect(repairs.map((stored) => stored.data)).toEqual([expect.objectContaining({ toolUseId: "call_1", isError: true,
      content: [{ type: "text", text: "The previous tool execution was interrupted before a result was committed. " +
        "Before retrying it, check whether it already took effect." }] })]);
    const [interrupted, answered] = await h.completions();
    expect(interrupted.pendingEventId).toBe(a.id);
    expect(answered.pendingEventId).toBe(b.id);
    // The Interrupted Turn is the one the lost Runner started: its repair and
    // its closing events join the call they answer.
    const [call] = await h.ofType("agent.tool_use");
    const started = (call.data as { turnId: string }).turnId;
    expect(interrupted.turnId).toBe(started);
    expect(repairs.map((stored) => (stored.data as { turnId: string }).turnId)).toEqual([started]);
    expect((await h.ofType("session.turn_aborted")).map((stored) => stored.data)).toEqual([{ turnId: started }]);
    // The repair, then the Interrupt, then the completion close A's Turn, before B runs.
    const types = log.map((stored) => stored.type);
    expect(types.slice(types.indexOf("agent.tool_use"))).toEqual(["agent.tool_use", "agent.tool_result", "session.turn_aborted",
      "session.turn_completed", "user.message", "session.status_running", "agent.message", "session.turn_completed", "session.status_idle"]);
    expect(log.filter((stored) => stored.type === "session.error")).toEqual([]);
    expect((await h.stores.sessionStore.getById(h.session.id))?.status).toBe("idle");
    expect(await h.stores.pendingEventStore.count(h.session.id)).toBe(0);
  });

  it("D1 ends a Turn interrupted before it committed output without running it again", async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const h = await harness({ A: async (input) => { started(); await aborted(input.signal!); } });
    await h.enqueue("A");
    const first = h.runner("runner-a");
    const draining = first.handleNewEvent(h.session.id, h.agent);
    await running;
    h.lost.add("runner-a");
    await first.requestInterrupt(h.session.id);
    await h.lose("runner-a", draining);

    await h.takeOver("runner-b");

    expect(h.requests).toEqual(["A"]);
    expect((await h.log()).map((stored) => stored.type)).toEqual(["user.message", "session.status_running",
      "session.turn_aborted", "session.turn_completed", "session.status_idle"]);
  });

  it("D2 an Interrupt accepted under the current generation still stops the running attempt itself", async () => {
    const turns: string[] = [];
    const h = await harness({ A: async (input, write) => { turns.push(input.turnId); await runsTool(input, write); }, B: answers });
    await h.enqueue("A");
    await h.enqueue("B");
    const only = h.runner("runner-a");
    const draining = only.handleNewEvent(h.session.id, h.agent);
    await until(async () => (await h.ofType("agent.tool_use")).length === 1);

    await only.requestInterrupt(h.session.id);
    await draining;
    expect(await only.waitForIdle(4000)).toBe(true);

    // The attempt that accepted the Interrupt applied it to its own Turn.
    expect(h.requests).toEqual(["A", "B"]);
    expect((await h.ofType("session.turn_aborted")).map((stored) => stored.data)).toEqual([{ turnId: turns[0] }]);
    expect((await h.completions())[0].turnId).toBe(turns[0]);
    expect((await h.ofType("agent.tool_result")).map((stored) => stored.data)).toEqual([expect.objectContaining({ toolUseId: "call_1", isError: true })]);
  });

  it("D3 completes a Turn whose Runner was lost after writing turn_aborted, without repeating the cleanup", async () => {
    const h = await harness({ A: runsTool, B: answers });
    await h.enqueue("A");
    await h.enqueue("B");
    // The Runner applies the Interrupt and dies right after committing turn_aborted.
    const append = h.stores.eventLogStore.append.bind(h.stores.eventLogStore);
    vi.spyOn(h.stores.eventLogStore, "append").mockImplementation(async (sessionId, input) => {
      const stored = await append(sessionId, input);
      if (input.type === "session.turn_aborted") h.lost.add("runner-a");
      return stored;
    });
    const first = h.runner("runner-a");
    const draining = first.handleNewEvent(h.session.id, h.agent);
    await until(async () => (await h.ofType("agent.tool_use")).length === 1);
    await first.requestInterrupt(h.session.id);
    await h.expire(draining);
    expect(await h.ofType("session.turn_aborted")).toHaveLength(1);
    expect(await h.ofType("session.turn_completed")).toEqual([]);

    await h.takeOver("runner-b");

    expect(h.requests).toEqual(["A", "B"]);
    expect(await h.ofType("session.turn_aborted")).toHaveLength(1);
    expect(await h.ofType("agent.tool_result")).toHaveLength(1);
    expect((await h.completions()).map((completion) => completion.pendingEventId)).toHaveLength(2);
    expect(await h.ofType("session.error")).toEqual([]);
  });

  it("D4 an Interrupt that arrives after the takeover stops the resumed attempt the usual way", async () => {
    let attempts = 0;
    let resumed!: () => void;
    const resumedRunning = new Promise<void>((resolve) => { resumed = resolve; });
    let started!: () => void;
    const firstRunning = new Promise<void>((resolve) => { started = resolve; });
    const h = await harness({
      A: async (input) => {
        if (++attempts === 1) started(); else resumed();
        await aborted(input.signal!);
      },
      B: answers,
    });
    await h.enqueue("A");
    await h.enqueue("B");
    const first = h.runner("runner-a");
    const draining = first.handleNewEvent(h.session.id, h.agent);
    await firstRunning;
    // Lost with no Interrupt and no output: the takeover runs the Turn.
    await h.lose("runner-a", draining);

    const replacement = h.runner("runner-b");
    const resuming = replacement.handleNewEvent(h.session.id, h.agent);
    await resumedRunning;
    expect(await replacement.requestInterrupt(h.session.id)).toEqual({ requested: true, interrupted: false });
    await resuming;
    expect(await replacement.waitForIdle(4000)).toBe(true);

    expect(h.requests).toEqual(["A", "A", "B"]);
    const [interrupted] = await h.completions();
    expect((await h.ofType("session.turn_aborted")).map((stored) => stored.data)).toEqual([{ turnId: interrupted.turnId }]);
    expect(await h.ofType("session.error")).toEqual([]);
  });

  it("D4 an Interrupt the takeover accepted outlives the takeover's own loss", async () => {
    let attempts = 0;
    let running!: () => void;
    let next = new Promise<void>((resolve) => { running = resolve; });
    const h = await harness({ A: async (input) => { attempts++; running(); await aborted(input.signal!); }, B: answers });
    await h.enqueue("A");
    await h.enqueue("B");
    const first = h.runner("runner-a");
    const draining = first.handleNewEvent(h.session.id, h.agent);
    await next;
    await h.lose("runner-a", draining);

    next = new Promise<void>((resolve) => { running = resolve; });
    const second = h.runner("runner-b");
    const resuming = second.handleNewEvent(h.session.id, h.agent);
    await next;
    h.lost.add("runner-b");
    await second.requestInterrupt(h.session.id);
    await h.lose("runner-b", resuming);

    await h.takeOver("runner-c");

    expect(attempts).toBe(2);
    expect(h.requests).toEqual(["A", "A", "B"]);
    expect(await h.ofType("session.turn_aborted")).toHaveLength(1);
    expect(await h.completions()).toHaveLength(2);
  });
});
