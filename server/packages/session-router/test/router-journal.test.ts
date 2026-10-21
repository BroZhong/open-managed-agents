import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createMemoryStores } from "@oma-server/store-memory";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { InMemoryTurnStreamStore } from "@oma-server/redis";
import { DefaultSandboxManager, FakeSandboxClient } from "@oma-server/sandbox";
import { presentEvent, type StoredEvent } from "@oma-server/store";
import type { Adapter, SessionEvent, StreamEvent, TurnJournalPort } from "@open-managed-agents/adapter-core";
import { journalWriter } from "@open-managed-agents/adapter-mock";
import { SessionRouter, type SessionRouterDeps } from "../src/session-router.js";

const event = (type: string, data: object = {}) => ({ id: randomUUID(), timestamp: new Date().toISOString(), type, ...data }) as SessionEvent;
const text = (message: string) => event("agent.message", { content: [{ type: "text", text: message }] });
const usage = () => event("span.model_request_end", { usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } });
const contextEntry = (id: string) => event("agent.context_entry", { sdk: "pi@0.83.0",
  entry: { id, type: "message", parentId: null, message: { role: "assistant", content: [{ type: "text", text: id }] } },
  presentation: { version: 1, blocks: [{ type: "agent.message", index: 0 }] } });
type DurableEvent = Exclude<SessionEvent, StreamEvent>;
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
  it("writes and publishes an event that the Adapter records twice once", async () => {
    const entry = contextEntry("assistant1");
    const h = await harness({ async *run(input) {
      const write = journalWriter(input);
      await write(entry);
      await write(entry);
    } });
    await h.enqueue();
    await h.router.handleNewEvent(h.session.id, h.agent);
    await sleep(0);

    expect((await h.log()).filter(stored => stored.type === "agent.context_entry")).toHaveLength(1);
    expect(h.appends.mock.calls.filter(([, input]) => input.type === "agent.context_entry")).toHaveLength(1);
    expect(h.frames.filter(frame => frame.type === "agent.context_entry")).toHaveLength(1);
  });

  it("publishes every durable event of an attempt once and in seq order, whichever flush wrote it", async () => {
    const entry = contextEntry("assistant1");
    const h = await harness({ async *run(input) {
      const write = journalWriter(input);
      input.journal!.record(entry as DurableEvent);
      const barrier = input.journal!.flush();
      // The Adapter moves on while that commit is still in flight.
      await write(usage());
      await barrier;
      await write(entry);
      await write(text("done"));
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
      const write = journalWriter(input);
      await write(text("committed"));
      // Pi reports a failed barrier with its own sticky error.
      await write(contextEntry("lost")).catch(() => { throw new Error("OMA commit barrier failed"); });
      await write(text("never written"));
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
      const write = journalWriter(input);
      if (input.execution?.isChild) { await write(text("child done")); return; }
      if (++parentRuns > 1) { await write(text("continued")); return; }
      await write(event("agent.tool_use", { toolUseId: "sync-call", name: "Agent", input: { prompt: "child" } }));
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

describe("an Adapter that writes through its journal entry", () => {
  /** An Adapter that waits for its Interrupt, then writes what an interrupted Pi would. */
  function interrupted(write: (journal: TurnJournalPort) => Promise<void>) {
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const failures: string[] = [];
    const adapter: Adapter = { async *run(input) {
      started();
      await new Promise<void>((resolve) => input.signal!.addEventListener("abort", () => resolve(), { once: true }));
      await write(input.journal!).catch((error: Error) => { failures.push(error.message); });
    } };
    return { adapter, running, failures };
  }

  it("keeps the Adapter's blockIndex and writes what it recorded last when run() ends", async () => {
    const entry = contextEntry("answer");
    if (entry.type === "agent.context_entry") entry.presentation = { version: 1, blocks: [{ type: "agent.message", index: 0, blockIndex: 0 }] };
    const last = usage();
    const deltas: Array<{ blockIndex?: number; turnId?: string }> = [];
    const h = await harness({ async *run(input) {
      expect(input.blockBase).toBe(0);
      input.journal!.delta(event("agent.message_stream_start") as StreamEvent, input.blockBase!);
      input.journal!.record(entry as DurableEvent);
      await input.journal!.flush();
      // Recorded after the Adapter's last flush.
      input.journal!.record(last as DurableEvent);
    } });
    const publishChunk = h.hub.publishChunk.bind(h.hub);
    h.hub.publishChunk = (sessionId, chunk) => { deltas.push({ blockIndex: chunk.blockIndex, turnId: chunk.turnId }); publishChunk(sessionId, chunk); };
    await h.enqueue();
    await h.router.handleNewEvent(h.session.id, h.agent);
    const log = await h.log();
    const turnId = (log.find(stored => stored.type === "session.turn_completed")!.data as { turnId: string }).turnId;
    expect(deltas).toEqual([{ blockIndex: 0, turnId }]);
    const display = log.flatMap(stored => presentEvent(stored)).find(stored => stored.type === "agent.message");
    expect(display?.data).toMatchObject({ turnId, blockIndex: 0 });
    const types = log.map(stored => stored.type);
    expect(types.indexOf("span.model_request_end")).toBeGreaterThan(types.indexOf("agent.context_entry"));
    expect(types.indexOf("span.model_request_end")).toBeLessThan(types.indexOf("session.turn_completed"));
    expect(log.find(stored => stored.type === "span.model_request_end")?.data).toMatchObject({ id: last.id, turnId });
    expectPublishedInOrder(h.frames, log);
  });

  it("renews the claim before an interrupted Adapter's flush and writes only its accounting", async () => {
    const aborted = contextEntry("aborted");
    const { adapter, running } = interrupted(async journal => {
      journal.record(aborted as DurableEvent);
      journal.record(usage() as DurableEvent);
      journal.record(event("agent.context_usage", { turnId: "t", model: "test", contextWindow: null, tokens: null, source: "unknown" }) as DurableEvent);
      await journal.flush();
    });
    const h = await harness(adapter);
    let interruptRequested = false;
    const writes: string[] = [];
    const renew = h.stores.pendingEventStore.renewClaim.bind(h.stores.pendingEventStore);
    h.stores.pendingEventStore.renewClaim = async (...args) => { if (interruptRequested) writes.push("renew"); return renew(...args); };
    h.appends.mockImplementation(async (sessionId, input) => { writes.push(input.type); return h.append(sessionId, input); });
    await h.enqueue();
    const processing = h.router.handleNewEvent(h.session.id, h.agent);
    await running;
    interruptRequested = true;
    h.router.interrupt(h.session.id);
    await processing;
    const types = (await h.log()).map(stored => stored.type);
    // The regular heartbeat stopped at the Interrupt; the accounting write renews first.
    expect(writes.indexOf("renew")).toBeGreaterThanOrEqual(0);
    expect(writes.indexOf("renew")).toBeLessThan(writes.indexOf("span.model_request_end"));
    expect(types).toEqual(expect.arrayContaining(["agent.context_entry", "span.model_request_end", "session.turn_aborted"]));
    expect(types).not.toContain("agent.context_usage");
    expect(types.indexOf("span.model_request_end")).toBeLessThan(types.indexOf("session.turn_aborted"));
  });

  it("writes nothing more from an interrupted Adapter once its renewed lease is lost", async () => {
    const { adapter, running, failures } = interrupted(async journal => {
      journal.record(usage() as DurableEvent);
      await journal.flush();
    });
    const h = await harness(adapter);
    let lost = false;
    const renew = h.stores.pendingEventStore.renewClaim.bind(h.stores.pendingEventStore);
    h.stores.pendingEventStore.renewClaim = async (...args) => lost ? false : renew(...args);
    await h.enqueue();
    const processing = h.router.handleNewEvent(h.session.id, h.agent);
    await running;
    lost = true;
    h.router.interrupt(h.session.id);
    await processing;
    const types = (await h.log()).map(stored => stored.type);
    expect(failures).toEqual(["Turn journal write entry revoked"]);
    expect(types).not.toContain("span.model_request_end");
    expect(types).not.toContain("session.turn_aborted");
  });

  it("revokes the entry at once when the Session is terminated, even after an Interrupt", async () => {
    let terminated!: () => void;
    const termination = new Promise<void>((resolve) => { terminated = resolve; });
    const recorded: string[] = [];
    const { adapter, running, failures } = interrupted(async journal => {
      await termination;
      journal.record(usage() as DurableEvent);
      recorded.push("usage");
      await journal.flush();
    });
    const h = await harness(adapter);
    await h.enqueue();
    const processing = h.router.handleNewEvent(h.session.id, h.agent);
    await running;
    h.router.interrupt(h.session.id);
    await h.stores.sessionStore.terminate(h.session.id);
    await h.router.terminateSession(h.session.id);
    terminated();
    await processing;
    expect(recorded).toEqual(["usage"]);
    expect(failures).toEqual(["Turn journal write entry revoked"]);
    expect((await h.log()).map(stored => stored.type)).not.toContain("span.model_request_end");
  });
});

describe("Deltas of a Turn attempt", () => {
  /** The Delta frames an SSE subscriber that asked for chunks receives, as parsed data. */
  function watchDeltas(hub: InProcessEventStreamHub, sessionId: string): Array<Record<string, unknown>> {
    const reader = hub.subscribe(sessionId, { includeChunks: true }).stream.getReader();
    const deltas: Array<Record<string, unknown>> = [];
    void (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        const lines = value.trim().split("\n");
        // Durable frames carry their seq as the SSE id; Deltas have none.
        if (lines.some(line => line.startsWith("id: "))) continue;
        deltas.push(JSON.parse(lines.find(line => line.startsWith("data: "))!.slice("data: ".length)));
      }
    })();
    return deltas;
  }

  it("tags live Delta frames and Redis records with the claim generation, also after an expired claim", async () => {
    const turnStreamStore = new InMemoryTurnStreamStore();
    const turnIds: string[] = [];
    let streamed!: () => void;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const h = await harness({ async *run(input) {
      turnIds.push(input.turnId);
      input.journal!.delta(event("agent.message_stream_start") as StreamEvent, input.blockBase!);
      input.journal!.delta(event("agent.message_chunk", { text: `attempt ${turnIds.length}` }) as StreamEvent, input.blockBase!);
      streamed();
      // The first attempt is lost before it commits anything, so the input is safely rerun.
      if (turnIds.length === 1) {
        await new Promise<void>((resolve) => input.signal!.addEventListener("abort", () => resolve(), { once: true }));
        return;
      }
      await finished;
      input.journal!.record(text("done") as DurableEvent);
    } });
    const live = watchDeltas(h.hub, h.session.id);
    // Attempts may share the Turn's stream, so each check reads only what is new since the last.
    const seenIds = new Set<string>();
    let seenFrames = 0;
    /** The attempt's two Deltas in Redis and on the live stream, as (attempt, type) pairs. */
    const streamedBy = async (turnId: string) => {
      const fresh = async () => (await turnStreamStore.readDeltas(h.session.id, turnId)).filter(delta => !seenIds.has(delta.id));
      await until(async () => (await fresh()).length === 2 && live.length - seenFrames === 2);
      const redis = await fresh();
      redis.forEach(delta => seenIds.add(delta.id));
      const frames = live.slice(seenFrames);
      seenFrames = live.length;
      expect(frames.every(frame => frame.turnId === turnId)).toBe(true);
      return {
        redis: redis.map(({ attempt, type }) => ({ attempt, type })),
        live: frames.map(({ attempt, type }) => ({ attempt, type })),
      };
    };
    const tagged = (attempt: number) => [
      { attempt, type: "agent.message_stream_start" },
      { attempt, type: "agent.message_chunk" },
    ];
    // runner-a loses its lease mid-attempt and never claims again.
    let lostOwner: string | undefined;
    const renew = h.stores.pendingEventStore.renewClaim.bind(h.stores.pendingEventStore);
    h.stores.pendingEventStore.renewClaim = async (sessionId, eventId, claim, leaseMs) =>
      claim.ownerId === lostOwner ? false : renew(sessionId, eventId, claim, leaseMs);
    const claim = h.stores.pendingEventStore.claim.bind(h.stores.pendingEventStore);
    h.stores.pendingEventStore.claim = async (sessionId, ownerId, leaseMs) =>
      ownerId === lostOwner ? null : claim(sessionId, ownerId, leaseMs);
    await h.enqueue();

    let started = new Promise<void>((resolve) => { streamed = resolve; });
    const first = h.makeRouter({ turnStreamStore, pendingClaimOwnerId: "runner-a", pendingClaimLeaseMs: 100,
      pendingClaimRenewIntervalMs: 30, wakeSession: () => {} });
    const lost = first.handleNewEvent(h.session.id, h.agent);
    await started;
    expect(await streamedBy(turnIds[0])).toEqual({ redis: tagged(1), live: tagged(1) });
    lostOwner = "runner-a";
    await lost;
    await sleep(120); // the lost claim expires

    started = new Promise<void>((resolve) => { streamed = resolve; });
    const replacement = h.makeRouter({ turnStreamStore, pendingClaimOwnerId: "runner-b" });
    const resumed = replacement.handleNewEvent(h.session.id, h.agent);
    await started;
    expect(await streamedBy(turnIds[1])).toEqual({ redis: tagged(2), live: tagged(2) });
    finish();
    await resumed;
    expect(await replacement.waitForIdle(4000)).toBe(true);
    expect((await h.log()).filter(stored => stored.type === "session.turn_completed")).toHaveLength(1);
  });
});
