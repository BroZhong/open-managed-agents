import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createMemoryStores } from "@oma-server/store-memory";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { PendingEventClaimLostError, type StoredEvent } from "@oma-server/store";
import type { Adapter, AdapterInput, AdapterRunResult, SessionEvent } from "@open-managed-agents/adapter-core";
import { journalWriter } from "@open-managed-agents/adapter-mock";
import { SessionRouter } from "../src/session-router.js";
import { OUTCOME_UNKNOWN } from "../src/dangling-call-results.js";

/**
 * Faults around a takeover (RECOVERY-MATRIX.md E9, A20): the Runner that
 * lost the Turn is still alive and writes late, and the attempt that takes
 * the Turn over fails in its runtime.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const aborted = (signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) resolve();
  else signal.addEventListener("abort", () => resolve(), { once: true });
});
async function until(check: () => Promise<boolean> | boolean, timeout = 4000) {
  const start = Date.now();
  while (!await check()) { if (Date.now() - start > timeout) throw new Error("Timed out"); await sleep(5); }
}
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}
const event = (type: string, data: object = {}) => ({ id: randomUUID(), timestamp: new Date().toISOString(), type, ...data }) as SessionEvent;
const inputText = (input: AdapterInput) => input.message.content.map((block) => block.type === "text" ? block.text : "").join("");

type Script = (input: AdapterInput, write: ReturnType<typeof journalWriter>, attempt: number) => Promise<AdapterRunResult | void>;

/** Runners sharing one durable store, with a short lease; a lost Runner never renews or claims again. */
async function harness(script: Script) {
  const stores = createMemoryStores();
  const agent = await stores.agentStore.create({ tenantId: "tenant", name: "Test", model: "test", system: "test",
    runtime: "pi-agent", sandbox: { enabled: false } });
  const workspace = await stores.workspaceStore.create({ tenantId: "tenant" });
  const session = await stores.sessionStore.create({ tenantId: "tenant", agentId: agent.id, agent, workspaceId: workspace.id });
  const attempts: AdapterInput[] = [];
  const adapter: Adapter = { async run(input) {
    attempts.push(input);
    return await script(input, journalWriter(input), attempts.length) ?? "finished";
  } };
  const lost = new Set<string>();
  const renew = stores.pendingEventStore.renewClaim.bind(stores.pendingEventStore);
  stores.pendingEventStore.renewClaim = async (sessionId, eventId, claim, leaseMs) =>
    lost.has(claim.ownerId) ? { renewed: false, interruptRequested: false } : renew(sessionId, eventId, claim, leaseMs);
  const claim = stores.pendingEventStore.claim.bind(stores.pendingEventStore);
  stores.pendingEventStore.claim = async (sessionId, ownerId, leaseMs) => lost.has(ownerId) ? null : claim(sessionId, ownerId, leaseMs);
  const errors: Array<{ owner: string; error: unknown }> = [];
  const hub = new InProcessEventStreamHub();
  const runner = (ownerId: string) => new SessionRouter({
    ...stores, eventStreamHub: hub, resolveAdapter: () => adapter,
    pendingClaimOwnerId: ownerId, pendingClaimLeaseMs: 100, pendingClaimRenewIntervalMs: 30,
    pendingClaimRetryMinMs: 10, pendingClaimRetryMaxMs: 20,
    onDrainError: ({ error }) => errors.push({ owner: ownerId, error }),
  });
  const enqueue = (text: string) => stores.pendingEventStore.enqueue(session.id, {
    type: "user.message", data: { content: [{ type: "text", text }] }, sessionThreadId: "sthr_primary",
  });
  const log = async () => (await stores.eventLogStore.getEvents(session.id, { limit: 1000 })).data;
  const ofType = async (type: string) => (await log()).filter((stored) => stored.type === type);
  return { stores, agent, session, attempts, lost, errors, runner, enqueue, log, ofType };
}

const texts = (log: StoredEvent[]) => JSON.stringify(log.map((stored) => stored.data));

describe("a takeover whose predecessor is still alive", () => {
  it("E9 a zombie Runner, its heartbeat paused past the lease, is fenced out: its late writes fail, it stops without a terminal event, and the takeover's Turn stands", async () => {
    const toolFinished = gate();
    const late: string[] = [];
    const h = await harness(async (input, write, attempt) => {
      if (attempt === 1) {
        await write(event("agent.tool_use", { toolUseId: "call_1", name: "bash", input: { command: "./migrate.sh" } }));
        // The tool finishes long after the pause began; the zombie reports what it saw.
        await toolFinished.opened;
        try {
          await write(event("agent.tool_result", { toolUseId: "call_1", content: [{ type: "text", text: "late result" }], isError: false }));
          await write(event("agent.message", { content: [{ type: "text", text: "late answer" }] }));
        } catch (error) { late.push((error as Error).name); }
        return;
      }
      if (!input.resume) throw new Error("The takeover continues the Turn");
      await write(event("agent.message", { content: [{ type: "text", text: "resumed answer" }] }));
    });
    // runner-a's heartbeat is paused, as in a long GC pause or a partition: it neither renews nor learns its lease is gone.
    const paused = gate();
    const renew = h.stores.pendingEventStore.renewClaim;
    h.stores.pendingEventStore.renewClaim = async (sessionId, eventId, claim, leaseMs) => {
      if (claim.ownerId === "runner-a") await paused.opened;
      return renew(sessionId, eventId, claim, leaseMs);
    };
    await h.enqueue("A");
    const zombie = h.runner("runner-a");
    const draining = zombie.handleNewEvent(h.session.id, h.agent);
    await until(async () => (await h.ofType("agent.tool_use")).length === 1);
    await sleep(150); // The lease runs out.

    const takeover = h.runner("runner-b");
    await takeover.handleNewEvent(h.session.id, h.agent);
    expect(await takeover.waitForIdle(4000)).toBe(true);
    const settled = await h.log();
    expect((await h.ofType("session.turn_completed")).map((stored) => stored.data)).toEqual([expect.objectContaining({ turnId: "turn_1_a1" })]);

    // The zombie wakes: its tool finished, it writes, and the fence refuses it.
    toolFinished.open();
    await until(() => late.length > 0);
    paused.open();
    await draining;
    expect(await zombie.waitForIdle(4000)).toBe(true);

    expect(late).toEqual(["PendingEventClaimLostError"]);
    expect(await h.log()).toEqual(settled);
    expect(texts(settled)).not.toContain("late result");
    expect(texts(settled)).not.toContain("late answer");
    // The call has one result, the takeover's, and the Turn one end, the takeover's.
    expect((await h.ofType("agent.tool_result")).map((stored) => stored.data)).toEqual([expect.objectContaining({ toolUseId: "call_1",
      id: expect.stringMatching(/^recovery_/), content: [{ type: "text", text: OUTCOME_UNKNOWN }] })]);
    expect(await h.ofType("session.error")).toEqual([]);
    expect(settled.at(-1)?.type).toBe("session.status_idle");
    expect(h.errors).toEqual([{ owner: "runner-a", error: expect.any(PendingEventClaimLostError) }]);
    expect(await h.stores.pendingEventStore.count(h.session.id)).toBe(0);
    expect(h.attempts.map((input) => input.turnId)).toEqual(["turn_1_a1", "turn_1_a1"]);
  });
});

describe("a takeover whose runtime fails", () => {
  it("A20 the takeover's Adapter run() throws: the Turn ends with adapter_error under its original Turn, after its dangling call was answered, and the queued input runs", async () => {
    const h = await harness(async (input, write, attempt) => {
      if (inputText(input) === "B") { await write(event("agent.message", { content: [{ type: "text", text: "B done" }] })); return; }
      if (attempt === 1) {
        await write(event("agent.tool_use", { toolUseId: "call_1", name: "bash", input: { command: "sleep 600" } }));
        await aborted(input.signal!);
        return;
      }
      throw new Error("runtime failed while resuming");
    });
    await h.enqueue("A");
    await h.enqueue("B");
    const first = h.runner("runner-a");
    const draining = first.handleNewEvent(h.session.id, h.agent);
    await until(async () => (await h.ofType("agent.tool_use")).length === 1);
    h.lost.add("runner-a");
    await draining;
    await sleep(120);

    const takeover = h.runner("runner-b");
    await takeover.handleNewEvent(h.session.id, h.agent);
    expect(await takeover.waitForIdle(4000)).toBe(true);

    expect(h.attempts.map((input) => [inputText(input), input.turnId, input.resume !== undefined])).toEqual([
      ["A", "turn_1_a1", false], ["A", "turn_1_a1", true], ["B", expect.not.stringMatching(/^turn_1_/), false]]);
    const log = await h.log();
    const types = log.map((stored) => stored.type);
    // Marker, repair, the runtime's failure, then the completion of the original Turn; then B.
    expect(types.slice(types.indexOf("agent.tool_use"), types.indexOf("session.turn_completed") + 1)).toEqual(["agent.tool_use",
      "session.turn_resumed", "agent.tool_result", "session.error", "session.turn_completed"]);
    expect((await h.ofType("agent.tool_result")).map((stored) => stored.data)).toEqual([expect.objectContaining({ toolUseId: "call_1",
      content: [{ type: "text", text: OUTCOME_UNKNOWN }] })]);
    expect((await h.ofType("session.error")).map((stored) => (stored.data as { error: { code: string; message: string } }).error))
      .toEqual([{ code: "adapter_error", message: expect.stringContaining("runtime failed while resuming") }]);
    const completions = (await h.ofType("session.turn_completed")).map((stored) => (stored.data as { turnId: string }).turnId);
    expect(completions).toHaveLength(2);
    expect(completions[0]).toBe("turn_1_a1");
    expect(texts(log)).toContain("B done");
    expect(log.at(-1)?.type).toBe("session.status_idle");
    expect(h.errors.filter(({ owner }) => owner === "runner-b")).toEqual([]);
  });
});
