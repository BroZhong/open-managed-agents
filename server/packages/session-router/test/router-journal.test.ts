import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createMemoryStores } from "@oma-server/store-memory";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { InMemoryTurnStreamStore } from "@oma-server/redis";
import { DefaultSandboxManager, FakeSandboxClient } from "@oma-server/sandbox";
import { PendingEventClaimLostError, presentEvent, type StoredEvent } from "@oma-server/store";
import type { Adapter, DurableEvent, SessionEvent, StreamEvent, TurnJournalPort } from "@open-managed-agents/adapter-core";
import { journalWriter } from "@open-managed-agents/adapter-mock";
import { SessionRouter, type SessionRouterDeps } from "../src/session-router.js";

const event = (type: string, data: object = {}) => ({ id: randomUUID(), timestamp: new Date().toISOString(), type, ...data }) as SessionEvent;
const text = (message: string) => event("agent.message", { content: [{ type: "text", text: message }] });
const usage = () => event("span.model_request_end", { usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } });
const contextEntry = (id: string) => event("agent.context_entry", { sdk: "pi@0.83.0",
  entry: { id, type: "message", parentId: null, message: { role: "assistant", content: [{ type: "text", text: id }] } },
  presentation: { version: 1, blocks: [{ type: "agent.message", index: 0 }] } });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const aborted = (signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) resolve();
  else signal.addEventListener("abort", () => resolve(), { once: true });
});
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
      sandboxManager: new DefaultSandboxManager({ sandboxClient }),
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
    const h = await harness({ async run(input) {
      const write = journalWriter(input);
      await write(entry);
      await write(entry);
      return "finished";
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
    const h = await harness({ async run(input) {
      const write = journalWriter(input);
      input.journal!.record(entry as DurableEvent);
      const barrier = input.journal!.flush();
      // The Adapter moves on while that commit is still in flight.
      await write(usage());
      await barrier;
      await write(entry);
      await write(text("done"));
      return "finished";
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

  it.each([
    "a journal write fails and the Adapter carries on",
    "a journal write fails and run() rejects",
    "the lease is lost",
  ] as const)("stops without terminal events when %s, leaving the input to the next claim", async (cause) => {
    const writeFails = cause !== "the lease is lost";
    let runs = 0;
    const h = await harness({ async run(input) {
      if (runs++ > 0) throw new Error("A committed final answer is not run again");
      const write = journalWriter(input);
      await write(text("committed"));
      if (cause === "a journal write fails and run() rejects") await write(contextEntry("lost"));
      // An Adapter that ignores its failed write is stopped by the Router all the same.
      if (cause === "a journal write fails and the Adapter carries on") await write(contextEntry("lost")).catch(() => {});
      await aborted(input.signal!);
      await write(text("never written")).catch(() => {});
      return "finished";
    } });
    if (writeFails) {
      let failures = 1;
      h.appends.mockImplementation(async (sessionId, input) => {
        if (input.type === "agent.context_entry" && failures-- > 0) throw new Error("connection reset");
        return h.append(sessionId, input);
      });
    }
    // Only the first claim's heartbeat finds its lease gone.
    const firstRenewals: number[] = [];
    const renew = h.stores.pendingEventStore.renewClaim.bind(h.stores.pendingEventStore);
    h.stores.pendingEventStore.renewClaim = async (sessionId, eventId, claim, leaseMs) => {
      if (claim.generation !== 1) return renew(sessionId, eventId, claim, leaseMs);
      firstRenewals.push(Date.now());
      return writeFails ? renew(sessionId, eventId, claim, leaseMs) : { renewed: false, interruptRequested: false };
    };
    const router = h.makeRouter({ pendingClaimLeaseMs: 60, pendingClaimRenewIntervalMs: 20 });
    await h.enqueue();
    await router.handleNewEvent(h.session.id, h.agent);

    expect((await h.log()).map(stored => stored.type)).toEqual(["user.message", "session.status_running", "agent.message"]);
    expect(await h.stores.pendingEventStore.count(h.session.id)).toBe(1);
    expect(h.errors).toEqual([expect.objectContaining({ message: writeFails ? "connection reset" : "Pending event lease lost" })]);
    // The heartbeat stopped with the attempt.
    const renewals = firstRenewals.length;
    await sleep(60);
    expect(firstRenewals).toHaveLength(renewals);
    // The pending scan claims it once the lease expires and resumes the Turn:
    // its committed final answer completes it without running it again.
    await until(async () => {
      await router.recoverPendingEvents();
      return await h.stores.pendingEventStore.count(h.session.id) === 0;
    });
    const recovered = await h.log();
    expect(recovered.filter(stored => stored.type === "agent.message")).toHaveLength(1);
    expect(recovered.filter(stored => stored.type === "session.error")).toEqual([]);
    expect(recovered.filter(stored => stored.type === "session.turn_resumed").map(stored => stored.data))
      .toEqual([expect.objectContaining({ generation: 2, reason: "expired", danglingToolUseIds: [] })]);
    expect(recovered.filter(stored => stored.type === "session.turn_completed")).toHaveLength(1);
    expect(recovered.some(stored => JSON.stringify(stored.data).includes("never written"))).toBe(false);
  });

  describe("writes that used to be appended without being published", () => {
    it("C12 publishes the Interrupt a Child execution's parent asked for before its lost owner applied it, and the Interrupted Turn", async () => {
      const h = await harness({ async run() { throw new Error("must not run"); } });
      const parent = await h.deadClaim();
      const caller = { tenantId: "tenant", callerSessionId: h.session.id, callerTurnId: parent.turnId };
      const execution = await h.stores.delegationStore.accept({ ...caller, callerToolUseId: "call", prompt: "child", mode: "sync",
        parentModel: "test", maxSteps: 30, sandboxSessionId: h.session.id }, parent.fence);
      const lost = (await h.stores.pendingEventStore.claim(execution.childId, "dead-host", 30_000))!;
      const lostFence = { eventId: execution.pendingEventId, ownerId: lost.ownerId, generation: lost.generation };
      await h.stores.delegationStore.startExecution(execution.id, lostFence, "child-turn", {}, 4);
      // The parent was interrupted while it waited; the child's Runner was lost before it saw the command.
      const command = await h.stores.delegationStore.command({ ...caller, callerToolUseId: `interrupt_${execution.id}`,
        childId: execution.childId, executionId: execution.id, kind: "interrupt", message: "The originating synchronous parent Turn was interrupted" }, parent.fence);
      await h.stores.pendingEventStore.releaseClaim(execution.childId, execution.pendingEventId, lostFence);
      const childFrames = watch(h.hub, execution.childId);

      const child = (await h.stores.sessionStore.getById(execution.childId))!;
      await h.router.handleNewEvent(child.id, child.agent);
      await sleep(0);

      const log = await h.log(child.id);
      expect(log.map(stored => stored.type)).toEqual(["delegation.input", "session.turn_resumed", "session.interrupt_requested",
        "session.turn_aborted", "session.turn_completed", "session.status_idle"]);
      expect(log[2].data).toMatchObject({ commandId: command.id, source: "delegation" });
      expectPublishedInOrder(childFrames, log);
      expect(await h.stores.delegationStore.getExecution("tenant", execution.id)).toMatchObject({ status: "interrupted" });
      expect(await h.stores.delegationStore.listCommands(execution.id)).toEqual([expect.objectContaining({ id: command.id, status: "applied", appliedEventSeq: log[2].seq })]);
      expect(h.errors).toEqual([]);
    });

    it("publishes the results a resumed wait and its dangling sibling get before the Turn continues", async () => {
      const h = await harness({ async run(input) {
        if (!input.resume) throw new Error("A resumed wait continues its Turn");
        await journalWriter(input)(text("continued"));
        return "finished";
      } }, { sandboxed: true });
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
      expect(log.filter(stored => stored.type === "session.error")).toEqual([]);
      const results = log.filter(stored => stored.type === "agent.tool_result");
      expect(results.map(stored => (stored.data as { toolUseId: string }).toolUseId).sort()).toEqual(["ordinary", "wait"]);
      for (const result of results) expect(h.frames.map(frame => frame.seq)).toContain(result.seq);
      expect(log.filter(stored => stored.type === "agent.message")).toHaveLength(1);
      expectPublishedInOrder(h.frames, log, before);
    });

    it("publishes turn_aborted when an Interrupt stops a resumed wait before the Adapter starts", async () => {
      const h = await harness({ async run() { throw new Error("must not run"); } }, { sandboxed: true });
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
    const h = await harness({ async run(input) {
      const write = journalWriter(input);
      if (input.execution?.isChild) { await write(text("child done")); return "finished"; }
      if (++parentRuns > 1) { await write(text("continued")); return "finished"; }
      await write(event("agent.tool_use", { toolUseId: "sync-call", name: "Agent", input: { prompt: "child" } }));
      await input.execution?.onResolved?.({ model: "test", thinking: "low", thinkingSource: "agent" });
      await input.subagents!.delegate({ prompt: "child", runInBackground: false }, { toolUseId: "sync-call" });
      return "finished";
    } }, { sandboxed: true });
    // The first Runner loses its lease while the parent waits on a child it never starts.
    let lostOwner: string | undefined;
    const renew = h.stores.pendingEventStore.renewClaim.bind(h.stores.pendingEventStore);
    h.stores.pendingEventStore.renewClaim = async (sessionId, eventId, claim, leaseMs) =>
      claim.ownerId === lostOwner ? { renewed: false, interruptRequested: false } : renew(sessionId, eventId, claim, leaseMs);
    // A lost Runner never claims again.
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

describe("recovery repairs written through the journal", () => {
  it("A15 answers dangling MCP calls under their server, or unknown when the call names none", async () => {
    const h = await harness({ async run() { throw new Error("must not run"); } });
    const parent = await h.deadClaim();
    for (const call of [{ toolUseId: "named", serverName: "docs" }, { toolUseId: "unnamed" }]) {
      await h.append(h.session.id, { type: "agent.mcp_tool_use", data: { ...event("agent.mcp_tool_use", { ...call, name: "search", input: {} }), turnId: parent.turnId },
        sessionThreadId: "sthr_primary", pendingFence: parent.fence });
    }
    await h.append(h.session.id, { type: "session.error", data: { error: { code: "adapter_error", message: "lost" } },
      sessionThreadId: "sthr_primary", pendingFence: parent.fence });
    await h.stores.pendingEventStore.releaseClaim(h.session.id, parent.pending.id, parent.claim);

    await h.router.handleNewEvent(h.session.id, h.agent);

    const log = await h.log();
    expect(log.filter(stored => stored.type === "agent.mcp_tool_result").map(stored => stored.data)).toEqual([
      expect.objectContaining({ toolUseId: "named", serverName: "docs", isError: true }),
      expect.objectContaining({ toolUseId: "unnamed", serverName: "unknown", isError: true }),
    ]);
    expect(log.filter(stored => stored.type === "session.turn_completed")).toHaveLength(1);
  });
});

describe("an Adapter that writes through its journal entry", () => {
  /** An Adapter that waits for its Interrupt, then writes what an interrupted Pi would. */
  function interrupted(write: (journal: TurnJournalPort) => Promise<void>) {
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    let settled!: () => void;
    const settlement = new Promise<void>((resolve) => { settled = resolve; });
    const failures: string[] = [];
    const adapter: Adapter = { async run(input) {
      started();
      await aborted(input.signal!);
      await write(input.journal).catch((error: Error) => { failures.push(error.message); });
      settled();
      return "finished";
    } };
    return { adapter, running, settlement, failures };
  }

  it("keeps the Adapter's blockIndex and writes what it recorded last when run() ends", async () => {
    const entry = contextEntry("answer");
    if (entry.type === "agent.context_entry") entry.presentation = { version: 1, blocks: [{ type: "agent.message", index: 0, blockIndex: 0 }] };
    const last = usage();
    const deltas: Array<{ blockIndex?: number; turnId?: string }> = [];
    const h = await harness({ async run(input) {
      // A new Turn numbers its blocks from 0.
      expect(input.resume).toBeUndefined();
      input.journal.delta(event("agent.message_stream_start") as StreamEvent, 0);
      input.journal!.record(entry as DurableEvent);
      await input.journal!.flush();
      // Recorded after the Adapter's last flush.
      input.journal!.record(last as DurableEvent);
      return "finished";
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

  it("writes what an interrupted Adapter records until run() settles, before turn_aborted", async () => {
    const { adapter, running } = interrupted(async journal => {
      // What Pi records as an Interrupt settles: the cut-short message and its accounting.
      journal.record(contextEntry("aborted") as DurableEvent);
      journal.record(usage() as DurableEvent);
      journal.record(event("agent.context_usage", { turnId: "t", model: "test", contextWindow: null, tokens: null, source: "unknown" }) as DurableEvent);
    });
    const h = await harness(adapter);
    await h.enqueue();
    const processing = h.router.handleNewEvent(h.session.id, h.agent);
    await running;
    h.router.interrupt(h.session.id);
    await processing;
    const log = await h.log();
    expect(log.map(stored => stored.type)).toEqual(["user.message", "session.status_running", "agent.context_entry",
      "span.model_request_end", "agent.context_usage", "session.turn_aborted", "session.turn_completed", "session.status_idle"]);
    expectPublishedInOrder(h.frames, log);
  });

  it("writes nothing from an interrupted Adapter after turn_aborted when cancelling its tool outlasts the drain timeout", async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    let settled!: () => void;
    const settlement = new Promise<void>((resolve) => { settled = resolve; });
    const late: string[] = [];
    const h = await harness({ async run(input) {
      input.journal.record(event("agent.tool_use", { toolUseId: "slow", name: "bash", input: { command: "sleep 600" } }) as DurableEvent);
      await input.journal.flush();
      started();
      await aborted(input.signal!);
      // At once: the message the Interrupt cut short and its usage.
      input.journal.record(text("half an answer") as DurableEvent);
      input.journal.record(usage() as DurableEvent);
      // Cancelling the running tool takes longer than the Router waits.
      await sleep(80);
      input.journal.delta(event("agent.message_stream_start") as StreamEvent, 2);
      input.journal.record(event("agent.tool_result", { toolUseId: "slow", content: [{ type: "text", text: "cancelled late" }], isError: true }) as DurableEvent);
      await input.journal.flush().catch((error: Error) => { late.push(error.message); });
      settled();
      return "finished";
    } });
    const deltas: unknown[] = [];
    const publishChunk = h.hub.publishChunk.bind(h.hub);
    h.hub.publishChunk = (sessionId, chunk) => { deltas.push(chunk); publishChunk(sessionId, chunk); };
    const router = h.makeRouter({ interruptedAdapterDrainTimeoutMs: 20 });
    await h.enqueue();
    const processing = router.handleNewEvent(h.session.id, h.agent);
    await running;
    router.interrupt(h.session.id);
    await processing;
    const closed = await h.log();
    expect(closed.map(stored => stored.type)).toEqual(["user.message", "session.status_running", "agent.tool_use",
      "agent.message", "span.model_request_end", "agent.tool_result", "session.turn_aborted", "session.turn_completed", "session.status_idle"]);
    // The dangling call got the Router's repair, not the Adapter's late result.
    expect(closed.find(stored => stored.type === "agent.tool_result")?.data).toMatchObject({ toolUseId: "slow", id: expect.stringMatching(/^recovery_/) });

    await settlement;
    await sleep(10);
    expect(late).toEqual(["Turn journal write entry revoked"]);
    expect(await h.log()).toEqual(closed);
    expectPublishedInOrder(h.frames, closed);
    expect(deltas).toEqual([]);
  });

  it("stops without terminal events when an interrupted Adapter's write finds the lease lost", async () => {
    let runs = 0;
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const late: string[] = [];
    const h = await harness({ async run(input) {
      if (++runs > 1) { await journalWriter(input)(text("rerun")); return "finished"; }
      started();
      await aborted(input.signal!);
      // The heartbeat stopped at the Interrupt, so the claim expires meanwhile.
      await sleep(100);
      input.journal.record(usage() as DurableEvent);
      await input.journal.flush().catch((error: Error) => { late.push(error.name); });
      return "finished";
    } });
    const router = h.makeRouter({ pendingClaimLeaseMs: 60, pendingClaimRenewIntervalMs: 20, interruptedAdapterDrainTimeoutMs: 1000 });
    await h.enqueue();
    const processing = router.handleNewEvent(h.session.id, h.agent);
    await running;
    router.interrupt(h.session.id);
    await processing;
    expect(late).toEqual(["PendingEventClaimLostError"]);
    expect(h.errors).toEqual([expect.any(PendingEventClaimLostError)]);
    expect((await h.log()).map(stored => stored.type)).toEqual(["user.message", "session.status_running"]);
    // The Interrupt was local, so the next claim reruns the Turn that committed nothing.
    await until(async () => await h.stores.pendingEventStore.count(h.session.id) === 0);
    const types = (await h.log()).map(stored => stored.type);
    expect(types).not.toContain("span.model_request_end");
    expect(types).not.toContain("session.turn_aborted");
    expect(types.filter(type => type === "session.turn_completed")).toHaveLength(1);
  });

  it("revokes the entry at once when the Session is terminated, even after an Interrupt", async () => {
    let terminated!: () => void;
    const termination = new Promise<void>((resolve) => { terminated = resolve; });
    const recorded: string[] = [];
    const { adapter, running, settlement, failures } = interrupted(async journal => {
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
    // A stopped attempt does not wait for its Adapter.
    await processing;
    await settlement;
    expect(recorded).toEqual(["usage"]);
    expect(failures).toEqual(["Turn journal write entry revoked"]);
    expect((await h.log()).map(stored => stored.type)).not.toContain("span.model_request_end");
  });
});

describe("a Turn attempt whose claim is gone", () => {
  /**
   * Another process takes the claim away while the Adapter runs. The attempt
   * finds out through its next write or, if it writes nothing, its heartbeat.
   */
  async function loseClaim(take: (h: Awaited<ReturnType<typeof harness>>) => Promise<void>, by: "write" | "heartbeat") {
    let wrote!: () => void;
    const first = new Promise<void>((resolve) => { wrote = resolve; });
    let taken!: () => void;
    const gone = new Promise<void>((resolve) => { taken = resolve; });
    const h = await harness({ async run(input) {
      const write = journalWriter(input);
      await write(text("before"));
      wrote();
      await gone;
      if (by === "write") await write(text("after")).catch(() => {});
      await aborted(input.signal!);
      return "finished";
    } });
    const router = h.makeRouter({ pendingClaimRenewIntervalMs: 20 });
    await h.enqueue();
    const processing = router.handleNewEvent(h.session.id, h.agent);
    await first;
    await take(h);
    taken();
    await processing;
    await sleep(20);
    return h;
  }

  it.each(["write", "heartbeat"] as const)("reports nothing when the Session was terminated by another process (found by its %s)", async (by) => {
    const h = await loseClaim(async (h) => {
      // The API's DELETE: PostgreSQL's terminate also deletes the Session's input, in one transaction.
      await h.stores.sessionStore.terminate(h.session.id);
      await h.stores.pendingEventStore.clear(h.session.id);
    }, by);

    // Termination stopped the attempt; that is no drain failure.
    expect(h.errors).toEqual([]);
    const types = (await h.log()).map((stored) => stored.type);
    expect(types.filter((type) => type === "agent.message")).toHaveLength(1);
    expect(types).not.toContain("session.turn_completed");
  });

  it("reports the lost claim when the Session is still active", async () => {
    const h = await loseClaim(async (h) => {
      // Another Runner holds the claim now.
      vi.spyOn(h.stores.pendingEventStore, "ownsClaim").mockResolvedValue(false);
    }, "write");

    expect(h.errors.map((error) => (error as Error).name)).toEqual(["PendingEventClaimLostError"]);
    expect((await h.log()).map((stored) => stored.type)).not.toContain("session.turn_completed");
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
    const h = await harness({ async run(input) {
      turnIds.push(input.turnId);
      input.journal.delta(event("agent.message_stream_start") as StreamEvent, 0);
      input.journal.delta(event("agent.message_chunk", { text: `attempt ${turnIds.length}` }) as StreamEvent, 0);
      streamed();
      // The first attempt is lost before it commits anything, so the input is safely rerun.
      if (turnIds.length === 1) {
        await new Promise<void>((resolve) => input.signal!.addEventListener("abort", () => resolve(), { once: true }));
        return "finished";
      }
      await finished;
      input.journal!.record(text("done") as DurableEvent);
      return "finished";
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
      claim.ownerId === lostOwner ? { renewed: false, interruptRequested: false } : renew(sessionId, eventId, claim, leaseMs);
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
