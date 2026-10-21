import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createMemoryStores } from "@oma-server/store-memory";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { DefaultSandboxManager, FakeSandboxClient } from "@oma-server/sandbox";
import { presentEvent, type StoredEvent } from "@oma-server/store";
import type { Adapter, SessionEvent } from "@open-managed-agents/adapter-core";
import { SessionRouter, type SessionRouterDeps } from "../src/session-router.js";

const event = (type: string, data: object = {}) => ({ id: randomUUID(), timestamp: new Date().toISOString(), type, ...data }) as SessionEvent;
const text = (message: string) => event("agent.message", { content: [{ type: "text", text: message }] });
const usage = () => event("span.model_request_end", { usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } });
const contextEntry = (id: string) => event("agent.context_entry", { sdk: "pi@0.83.0",
  entry: { id, type: "message", parentId: null, message: { role: "assistant", content: [{ type: "text", text: id }] } },
  presentation: { version: 1, blocks: [{ type: "agent.message", index: 0 }] } });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>, timeout = 4000) {
  const start = Date.now();
  while (!await check()) { if (Date.now() - start > timeout) throw new Error("Timed out"); await sleep(10); }
}

interface Frame { type: string; seq: number }

/** The durable frames an SSE subscriber of the in-process hub receives. */
function watch(hub: InProcessEventStreamHub, sessionId: string): Frame[] {
  const reader = hub.subscribe(sessionId).stream.getReader();
  const frames: Frame[] = [];
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      const fields = Object.fromEntries(value.trim().split("\n").map(line => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]));
      frames.push({ type: fields.event, seq: Number(fields.id) });
    }
  })();
  return frames;
}

/** Delegation needs a managed Sandbox, so `sandboxed` Agents get a fake one. */
async function harness(adapter: Adapter, options: { sandboxed?: boolean } = {}) {
  const stores = createMemoryStores();
  const agent = await stores.agentStore.create({ tenantId: "tenant", name: "Test", model: "test", system: "test",
    runtime: "pi-agent", sandbox: { enabled: options.sandboxed ?? false } });
  const workspace = await stores.workspaceStore.create({ tenantId: "tenant" });
  const session = await stores.sessionStore.create({ tenantId: "tenant", agentId: agent.id, agent, workspaceId: workspace.id });
  const hub = new InProcessEventStreamHub();
  const frames = watch(hub, session.id);
  const append = stores.eventLogStore.append.bind(stores.eventLogStore);
  const appends = vi.spyOn(stores.eventLogStore, "append");
  const sandboxClient = new FakeSandboxClient();
  const errors: unknown[] = [];
  const makeRouter = (deps: Partial<SessionRouterDeps> = {}) => new SessionRouter({
    ...stores, eventStreamHub: hub, resolveAdapter: () => adapter,
    ...(options.sandboxed ? {
      sandboxManager: new DefaultSandboxManager({ sandboxClient, provisionSources: {} }),
      workspaceMount: { bucket: "agentry", agentName: "agentry-workspace", pvName: "agentry-workspace-oss", credentialProviderName: "agentry-oss-rw" },
    } : {}),
    pendingClaimRetryMinMs: 10, pendingClaimRetryMaxMs: 20,
    onDrainError: ({ error }) => errors.push(error),
    ...deps,
  });
  const enqueue = (message = "go") => stores.pendingEventStore.enqueue(session.id, {
    type: "user.message", data: { content: [{ type: "text", text: message }] }, sessionThreadId: "sthr_primary",
  });
  const log = async (sessionId = session.id) => (await stores.eventLogStore.getEvents(sessionId, { limit: 1000 })).data;
  /** A lost Runner's claim on the parent's input, under which a test writes its leftovers. */
  const deadClaim = async () => {
    const pending = await enqueue();
    const claim = (await stores.pendingEventStore.claim(session.id, "dead-host", 30_000))!;
    const fence = { eventId: pending.id, ownerId: claim.ownerId, generation: claim.generation };
    const promoted = await append(session.id, { type: pending.type, data: pending.data, sessionThreadId: "sthr_primary",
      idempotencyKey: `pending:${pending.id}`, pendingFence: fence });
    await append(session.id, { type: "session.status_running", data: {}, sessionThreadId: "sthr_primary",
      idempotencyKey: `pending:${pending.id}:status_running`, pendingFence: fence });
    return { pending, claim, fence, turnId: `turn_${promoted.seq}_a${claim.generation}` };
  };
  return { stores, agent, session, hub, frames, append, appends, makeRouter, router: makeRouter(), enqueue, log, deadClaim, errors };
}

/**
 * Every row newer than `afterSeq` was published once, in seq order, as the
 * frames SSE sends (a native entry also carries its display rows). Rows a
 * store transaction wrote on its own are left out by type.
 */
function expectPublishedInOrder(frames: Frame[], log: StoredEvent[], afterSeq = 0, storeWrites: string[] = []) {
  const seqs = frames.map(frame => frame.seq);
  expect(seqs).toEqual([...new Set(seqs)].sort((a, b) => a - b));
  expect(seqs.filter(seq => seq > afterSeq)).toEqual(log.filter(stored => !storeWrites.includes(stored.type))
    .flatMap(stored => presentEvent(stored)).map(stored => stored.seq).filter(seq => seq > afterSeq));
}

describe("SessionRouter writes each Turn attempt through one TurnJournal", () => {
  it("writes and publishes an event that the commit barrier and the event stream both deliver once", async () => {
    const entry = contextEntry("assistant1");
    const h = await harness({ async *run(input) {
      await input.persistContext!([entry]);
      yield entry;
    } });
    await h.enqueue();
    await h.router.handleNewEvent(h.session.id, h.agent);
    await sleep(0);

    expect((await h.log()).filter(stored => stored.type === "agent.context_entry")).toHaveLength(1);
    expect(h.appends.mock.calls.filter(([, input]) => input.type === "agent.context_entry")).toHaveLength(1);
    expect(h.frames.filter(frame => frame.type === "agent.context_entry")).toHaveLength(1);
  });

  it("publishes every durable event of an attempt once and in seq order, whichever path recorded it", async () => {
    const entry = contextEntry("assistant1");
    const h = await harness({ async *run(input) {
      const barrier = input.persistContext!([entry]);
      // The stream moves on while the barrier commit is still in flight.
      yield usage();
      await barrier;
      yield entry;
      yield text("done");
    } });
    // A slow commit returns after its seq is allocated, as PG would.
    h.appends.mockImplementation(async (sessionId, input) => {
      const stored = await h.append(sessionId, input);
      if (input.type === "agent.context_entry") await sleep(30);
      return stored;
    });
    await h.enqueue();
    await h.router.handleNewEvent(h.session.id, h.agent);
    await sleep(0);

    const log = await h.log();
    expect(log.map(stored => stored.type)).toEqual(["user.message", "session.status_running", "agent.context_entry",
      "span.model_request_end", "agent.message", "session.turn_completed", "session.status_idle"]);
    expectPublishedInOrder(h.frames, log);
  });

  it("stops without terminal events when a write fails, leaving the input to the next claim", async () => {
    const h = await harness({ async *run(input) {
      yield text("committed");
      // Pi reports a failed barrier with its own sticky error.
      await input.persistContext!([contextEntry("lost")]).catch(() => { throw new Error("OMA commit barrier failed"); });
      yield text("never written");
    } });
    let failures = 1;
    h.appends.mockImplementation(async (sessionId, input) => {
      if (input.type === "agent.context_entry" && failures-- > 0) throw new Error("connection reset");
      return h.append(sessionId, input);
    });
    const router = h.makeRouter({ pendingClaimLeaseMs: 60, pendingClaimRenewIntervalMs: 20 });
    await h.enqueue();
    await expect(router.handleNewEvent(h.session.id, h.agent)).rejects.toThrow("connection reset");

    expect((await h.log()).map(stored => stored.type)).toEqual(["user.message", "session.status_running", "agent.message"]);
    expect(await h.stores.pendingEventStore.count(h.session.id)).toBe(1);
    // The next claim ends the Turn by the recovery rules, never rerunning it.
    await until(async () => await h.stores.pendingEventStore.count(h.session.id) === 0);
    const recovered = await h.log();
    expect(recovered.filter(stored => stored.type === "agent.message")).toHaveLength(1);
    expect(recovered.find(stored => stored.type === "session.error")?.data).toMatchObject({ error: { code: "recovery_partial_turn_aborted" } });
    expect(recovered.filter(stored => stored.type === "session.turn_completed")).toHaveLength(1);
  });

  describe("writes that used to be appended without being published", () => {
    it("publishes the recovery_required error of a Child execution its lost owner left running", async () => {
      const h = await harness({ async *run() { throw new Error("must not run"); } });
      const parent = await h.deadClaim();
      const execution = await h.stores.delegationStore.accept({ tenantId: "tenant", callerSessionId: h.session.id,
        callerTurnId: parent.turnId, callerToolUseId: "call", prompt: "child", mode: "sync", parentModel: "test",
        maxSteps: 30, sandboxSessionId: h.session.id }, parent.fence);
      const lost = (await h.stores.pendingEventStore.claim(execution.childId, "dead-host", 30_000))!;
      const lostFence = { eventId: execution.pendingEventId, ownerId: lost.ownerId, generation: lost.generation };
      await h.stores.delegationStore.startExecution(execution.id, lostFence, "child-turn", {}, 4);
      await h.stores.pendingEventStore.releaseClaim(execution.childId, execution.pendingEventId, lostFence);
      const childFrames = watch(h.hub, execution.childId);

      const child = (await h.stores.sessionStore.getById(execution.childId))!;
      await h.router.handleNewEvent(child.id, child.agent);
      await sleep(0);

      const log = await h.log(child.id);
      expect(log.map(stored => stored.type)).toEqual(["delegation.input", "session.error", "session.turn_completed", "session.status_idle"]);
      expect(log[1].data).toMatchObject({ error: { code: "recovery_required" } });
      expectPublishedInOrder(childFrames, log);
    });

    it("publishes the error that ends a resumed wait whose sibling tool has an uncertain outcome", async () => {
      const h = await harness({ async *run() { throw new Error("must not run"); } }, { sandboxed: true });
      const parent = await h.deadClaim();
      await h.append(h.session.id, { type: "agent.tool_use", data: { ...event("agent.tool_use", { toolUseId: "ordinary", name: "bash", input: {} }), turnId: parent.turnId },
        sessionThreadId: "sthr_primary", pendingFence: parent.fence });
      const execution = await h.stores.delegationStore.accept({ tenantId: "tenant", callerSessionId: h.session.id,
        callerTurnId: parent.turnId, callerToolUseId: "wait", prompt: "child", mode: "sync", parentModel: "test",
        maxSteps: 30, sandboxSessionId: h.session.id }, parent.fence);
      const childClaim = (await h.stores.pendingEventStore.claim(execution.childId, "child-host", 30_000))!;
      const childFence = { eventId: execution.pendingEventId, ownerId: childClaim.ownerId, generation: childClaim.generation };
      await h.stores.delegationStore.startExecution(execution.id, childFence, "child-turn", {}, 4);
      await h.stores.delegationStore.finishExecution(execution.id, childFence, { status: "completed", output: "done", reason: "finished", trace: { sessionId: execution.childId } });
      await h.stores.pendingEventStore.ack(execution.childId, execution.pendingEventId, childFence);
      await h.stores.pendingEventStore.releaseClaim(h.session.id, parent.pending.id, parent.claim);
      const before = (await h.log()).at(-1)!.seq;

      await h.router.handleNewEvent(h.session.id, h.agent);
      await sleep(0);

      const log = await h.log();
      const errors = log.filter(stored => stored.type === "session.error");
      expect(errors).toEqual([expect.objectContaining({ data: expect.objectContaining({ error: expect.objectContaining({ code: "recovery_required" }) }) })]);
      expect(h.frames.map(frame => frame.seq)).toContain(errors[0].seq);
      expectPublishedInOrder(h.frames, log, before);
    });

    it("publishes turn_aborted when an Interrupt stops a resumed wait before the Adapter starts", async () => {
      const h = await harness({ async *run() { throw new Error("must not run"); } }, { sandboxed: true });
      const parent = await h.deadClaim();
      await h.stores.delegationStore.accept({ tenantId: "tenant", callerSessionId: h.session.id,
        callerTurnId: parent.turnId, callerToolUseId: "wait", prompt: "child", mode: "sync", parentModel: "test",
        maxSteps: 30, sandboxSessionId: h.session.id }, parent.fence);
      await h.stores.pendingEventStore.releaseClaim(h.session.id, parent.pending.id, parent.claim);
      const before = (await h.log()).at(-1)!.seq;
      // The child never runs, so the resumed wait lasts until the Interrupt.
      const router = h.makeRouter({ wakeSession: () => {} });

      const running = router.handleNewEvent(h.session.id, h.agent);
      await until(async () => (await h.stores.sessionStore.getById(h.session.id))?.status === "waiting");
      router.interrupt(h.session.id);
      await running;
      await sleep(0);

      const log = await h.log();
      const aborted = log.filter(stored => stored.type === "session.turn_aborted");
      expect(aborted).toHaveLength(1);
      expect(h.frames.map(frame => frame.seq)).toContain(aborted[0].seq);
      // Interrupting the queued child commits its result notification in the
      // delegation transaction, outside this attempt.
      expectPublishedInOrder(h.frames, log, before, ["subagent.result"]);
    });
  });

  it("records a wait's waiting transition once when a replacement Runner resumes the wait", async () => {
    let parentRuns = 0;
    const h = await harness({ async *run(input) {
      if (input.execution?.isChild) { yield text("child done"); return; }
      if (++parentRuns > 1) { yield text("continued"); return; }
      yield event("agent.tool_use", { toolUseId: "sync-call", name: "Agent", input: { prompt: "child" } });
      await input.execution?.onResolved?.({ model: "test", thinking: "low", thinkingSource: "agent" });
      await input.subagents!.delegate({ prompt: "child", runInBackground: false }, { toolUseId: "sync-call" });
    } }, { sandboxed: true });
    // The first Runner loses its lease while the parent waits on a child it never starts.
    let lostOwner: string | undefined;
    const renew = h.stores.pendingEventStore.renewClaim.bind(h.stores.pendingEventStore);
    h.stores.pendingEventStore.renewClaim = async (sessionId, eventId, claim, leaseMs) =>
      claim.ownerId === lostOwner ? false : renew(sessionId, eventId, claim, leaseMs);
    // A lost Runner never claims again, even though its retry timer is still armed here.
    const claim = h.stores.pendingEventStore.claim.bind(h.stores.pendingEventStore);
    h.stores.pendingEventStore.claim = async (sessionId, ownerId, leaseMs) =>
      ownerId === lostOwner ? null : claim(sessionId, ownerId, leaseMs);
    const first = h.makeRouter({ pendingClaimOwnerId: "runner-a", pendingClaimLeaseMs: 100, pendingClaimRenewIntervalMs: 30, wakeSession: () => {} });
    await h.enqueue();
    const lost = first.handleNewEvent(h.session.id, h.agent);
    await until(async () => (await h.stores.sessionStore.getById(h.session.id))?.status === "waiting");
    lostOwner = "runner-a";
    await lost;
    await sleep(120); // the lost claim expires

    const replacement = h.makeRouter({ pendingClaimOwnerId: "runner-b" });
    await replacement.handleNewEvent(h.session.id, h.agent);
    expect(await replacement.waitForIdle(4000)).toBe(true);

    const log = await h.log();
    expect(parentRuns).toBe(2);
    expect(log.filter(stored => stored.type === "session.status_waiting")).toHaveLength(1);
    expect(log.filter(stored => stored.type === "agent.tool_result")).toHaveLength(1);
    expect(log.filter(stored => stored.type === "session.turn_completed")).toHaveLength(1);
    const waits = h.appends.mock.calls.filter(([sessionId]) => sessionId === h.session.id).map(([, input]) => input)
      .filter(input => input.type === "session.status_waiting" || input.type === "session.status_running");
    expect(new Set(waits.map(input => input.idempotencyKey))).toEqual(new Set([
      expect.stringMatching(/^pending:.+:status_running$/),
      expect.stringMatching(/^pending:.+:status_waiting:sync-call$/),
      expect.stringMatching(/^pending:.+:status_running:sync-call$/),
    ]));
  });
});
