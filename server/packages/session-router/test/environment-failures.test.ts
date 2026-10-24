import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createMemoryStores } from "@oma-server/store-memory";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { DefaultSandboxManager, DefaultTurnSandboxes, FakeSandboxClient, SandboxCreateRejected } from "@oma-server/sandbox";
import type { StoredEvent } from "@oma-server/store";
import type { Adapter, AdapterInput, SessionEvent } from "@open-managed-agents/adapter-core";
import { journalWriter } from "@open-managed-agents/adapter-mock";
import { SessionRouter } from "../src/session-router.js";
import { PREPARE_ATTEMPT_STOPPED } from "../src/sandbox-prepare-spans.js";

/**
 * An environment failure is a tool error, not the end of the Turn (ADR-0023,
 * #287): the Turn runs on, records each preparation as a span, and only its
 * end records `sandbox_unavailable`, when its environment never became ready
 * again. Real Sandbox Manager and Turn Sandboxes over a fake gateway.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean> | boolean, timeout = 4000) {
  const start = Date.now();
  while (!await check()) { if (Date.now() - start > timeout) throw new Error("Timed out"); await sleep(5); }
}
const aborted = (signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) resolve();
  else signal.addEventListener("abort", () => resolve(), { once: true });
});
const event = (type: string, data: object = {}) => ({ id: randomUUID(), timestamp: new Date().toISOString(), type, ...data }) as SessionEvent;
const workspaceMount = { bucket: "agentry", agentName: "agentry-workspace", pvName: "agentry-workspace-oss", credentialProviderName: "agentry-oss-rw" };

type Write = ReturnType<typeof journalWriter>;
type Script = (input: AdapterInput, write: Write, attempt: number) => Promise<void>;

/** Runners sharing one store and one gateway, each with its own Sandbox Manager; a lost Runner never renews or claims again. */
async function harness(script: Script) {
  const stores = createMemoryStores();
  const agent = await stores.agentStore.create({ tenantId: "tenant", name: "Test", model: "test", system: "test",
    runtime: "pi-agent", sandbox: { enabled: true } });
  const workspace = await stores.workspaceStore.create({ tenantId: "tenant" });
  const session = await stores.sessionStore.create({ tenantId: "tenant", agentId: agent.id, agent, workspaceId: workspace.id });
  const gateway = new FakeSandboxClient();
  const attempts: AdapterInput[] = [];
  const adapter: Adapter = { async run(input) {
    attempts.push(input);
    await script(input, journalWriter(input), attempts.length);
    return "finished";
  } };
  const lost = new Set<string>();
  const renew = stores.pendingEventStore.renewClaim.bind(stores.pendingEventStore);
  stores.pendingEventStore.renewClaim = async (sessionId, eventId, claim, leaseMs) =>
    lost.has(claim.ownerId) ? { renewed: false, interruptRequested: false } : renew(sessionId, eventId, claim, leaseMs);
  const claim = stores.pendingEventStore.claim.bind(stores.pendingEventStore);
  stores.pendingEventStore.claim = async (sessionId, ownerId, leaseMs) => lost.has(ownerId) ? null : claim(sessionId, ownerId, leaseMs);
  const errors: Array<{ owner: string; error: unknown }> = [];
  const hub = new InProcessEventStreamHub();
  const runner = (ownerId = "runner-a") => new SessionRouter({
    ...stores, eventStreamHub: hub, resolveAdapter: () => adapter,
    sandboxes: new DefaultTurnSandboxes({ manager: new DefaultSandboxManager({ sandboxClient: gateway, environment: "test" }),
      bindings: stores.delegationStore, sessions: stores.sessionStore, workspaceMount,
      onError: ({ error }) => errors.push({ owner: ownerId, error }) }),
    pendingClaimOwnerId: ownerId, pendingClaimLeaseMs: 100, pendingClaimRenewIntervalMs: 30,
    pendingClaimRetryMinMs: 10, pendingClaimRetryMaxMs: 20,
    onDrainError: ({ error }) => errors.push({ owner: ownerId, error }),
  });
  const enqueue = (text: string) => stores.pendingEventStore.enqueue(session.id, {
    type: "user.message", data: { content: [{ type: "text", text }] }, sessionThreadId: "sthr_primary",
  });
  /** One input, run to idle on `on`. */
  const turn = async (text: string, on = runner()) => {
    await enqueue(text);
    await on.handleNewEvent(session.id, agent);
    expect(await on.waitForIdle(4000)).toBe(true);
  };
  const log = async () => (await stores.eventLogStore.getEvents(session.id, { limit: 1000 })).data;
  const ofType = async (type: string) => (await log()).filter((stored) => stored.type === type);
  return { stores, agent, session, gateway, attempts, lost, errors, runner, enqueue, turn, log, ofType };
}

/** A tool call through the Turn's executor, recorded as Pi records it: its result is an error the model sees. */
async function tool(input: AdapterInput, write: Write, id: string): Promise<unknown> {
  await write(event("agent.tool_use", { toolUseId: id, name: "write", input: { path: "note.txt" } }));
  try {
    await input.toolExecutor!.writeFile("note.txt", id);
    await write(event("agent.tool_result", { toolUseId: id, content: [{ type: "text", text: "written" }], isError: false }));
    return undefined;
  } catch (error) {
    await write(event("agent.tool_result", { toolUseId: id, content: [{ type: "text", text: (error as Error).message }], isError: true }));
    return error;
  }
}
const answer = (write: Write, text = "done") => write(event("agent.message", { content: [{ type: "text", text }] }));
const spansOf = (log: StoredEvent[]) => log.filter((stored) => stored.type.startsWith("span.sandbox_prepare_"))
  .map((stored) => [stored.type, stored.data]);
const errorCodes = (log: StoredEvent[]) => log.filter((stored) => stored.type === "session.error")
  .map((stored) => (stored.data as { error: { code: string } }).error.code);

describe("an environment failure is a tool error (ADR-0023)", () => {
  it("runs a Turn whose environment is never available to its answer, and ends it with one sandbox_unavailable", async () => {
    const failures: unknown[] = [];
    const h = await harness(async (input, write) => {
      failures.push(await tool(input, write, "call_1"), await tool(input, write, "call_2"));
      await answer(write, "the Sandbox is unavailable");
    });
    h.gateway.createFault = (step) => { if (step === "claim") throw new SandboxCreateRejected(403); };
    await h.turn("write a note");

    expect(failures).toEqual([0, 1].map(() => expect.objectContaining({ name: "SandboxUnavailable", code: "sandbox_unavailable",
      reason: "rejected", details: { reason: "rejected" } })));
    const log = await h.log();
    const [start, end] = ["session.status_running", "session.turn_completed"].map((type) => log.findIndex((stored) => stored.type === type));
    const turn = log.slice(start, end + 1);
    // The Turn ran on after each failure; the error is written once, at its end.
    expect(turn.map((stored) => stored.type).filter((type) => !type.startsWith("span.model"))).toEqual(["session.status_running",
      "agent.tool_use", "span.sandbox_prepare_start", "span.sandbox_prepare_end", "agent.tool_result",
      "agent.tool_use", "span.sandbox_prepare_start", "span.sandbox_prepare_end", "agent.tool_result",
      "agent.message", "session.error", "session.turn_completed"]);
    expect(errorCodes(log)).toEqual(["sandbox_unavailable"]);
    expect((await h.ofType("session.error"))[0].data).toEqual({ turnId: "turn_1_a1", error: { code: "sandbox_unavailable",
      message: expect.stringContaining("The answer is retained") } });
    expect(spansOf(log)).toEqual([
      ["span.sandbox_prepare_start", { turnId: "turn_1_a1", prepareId: "1.1" }],
      ["span.sandbox_prepare_end", { turnId: "turn_1_a1", prepareId: "1.1", outcome: "failed", code: "sandbox_unavailable", reason: "rejected", durationMs: expect.any(Number) }],
      ["span.sandbox_prepare_start", { turnId: "turn_1_a1", prepareId: "1.2" }],
      ["span.sandbox_prepare_end", { turnId: "turn_1_a1", prepareId: "1.2", outcome: "failed", code: "sandbox_unavailable", reason: "rejected", durationMs: expect.any(Number) }],
    ]);
    expect((await h.stores.sessionStore.getById(h.session.id))?.status).toBe("idle");
    expect(h.errors).toEqual([]);

    // The next Turn, whose environment works again, records no error.
    h.gateway.createFault = undefined;
    await h.turn("again");
    expect(errorCodes(await h.log())).toEqual(["sandbox_unavailable"]);
  });

  it("records no error for a Turn whose environment failed once and then became ready", async () => {
    const failures: unknown[] = [];
    const h = await harness(async (input, write) => {
      failures.push(await tool(input, write, "call_1"), await tool(input, write, "call_2"));
      await answer(write);
    });
    let creates = 0;
    h.gateway.createFault = (step) => { if (step === "claim" && ++creates === 1) throw new SandboxCreateRejected(403); };
    await h.turn("write a note");
    expect(failures).toEqual([expect.objectContaining({ code: "sandbox_unavailable" }), undefined]);
    const log = await h.log();
    expect(errorCodes(log)).toEqual([]);
    expect(spansOf(log).filter(([type]) => type === "span.sandbox_prepare_end").map(([, data]) => data)).toEqual([
      expect.objectContaining({ outcome: "failed", code: "sandbox_unavailable" }),
      expect.objectContaining({ outcome: "ready", sandboxId: h.gateway.created[0] }),
    ]);
    expect(h.gateway.workspaceContents(`tenant/${h.session.workspaceId}/`).get("note.txt")?.content).toBe("call_2");
  });

  it("starts the model's first request without waiting for the Sandbox's connect, which the first tool waits for", async () => {
    const order: string[] = [];
    const h = await harness(async (input, write) => {
      order.push("adapter started");
      const failure = await tool(input, write, `call_${order.length}`);
      order.push(failure ? "tool failed" : "tool ran");
      await answer(write);
    });
    await h.turn("create the Sandbox");
    order.length = 0;
    let connected!: () => void;
    const connecting = new Promise<void>((resolve) => { connected = resolve; });
    const reconnect = h.gateway.reconnect.bind(h.gateway);
    vi.spyOn(h.gateway, "reconnect").mockImplementation(async (id, metadata) => {
      order.push("connecting");
      await connecting;
      return reconnect(id, metadata);
    });
    const router = h.runner();
    await h.enqueue("use it");
    void router.handleNewEvent(h.session.id, h.agent);
    await until(() => order.includes("adapter started"));
    await sleep(20);
    expect(order).toEqual(["connecting", "adapter started"]);
    connected();
    expect(await router.waitForIdle(4000)).toBe(true);
    expect(order).toEqual(["connecting", "adapter started", "tool ran"]);
    expect(h.gateway.created).toHaveLength(1);
    const spans = spansOf(await h.log()).slice(2);
    expect(spans).toEqual([
      ["span.sandbox_prepare_start", { turnId: expect.any(String), prepareId: "1.1" }],
      ["span.sandbox_prepare_end", expect.objectContaining({ prepareId: "1.1", outcome: "ready", sandboxId: h.gateway.created[0] })],
    ]);
  });

  it("waits at its end for a Turn-start connect the Turn outran, so the connect's span and the install it starts are the Turn's", async () => {
    const h = await harness(async (input, write) => {
      if (input.message.content.some((block) => block.type === "text" && block.text === "create")) await tool(input, write, "call_1");
      await answer(write);
    });
    await h.turn("create");
    let connected!: () => void;
    const connecting = new Promise<void>((resolve) => { connected = resolve; });
    const reconnect = h.gateway.reconnect.bind(h.gateway);
    vi.spyOn(h.gateway, "reconnect").mockImplementation(async (id, metadata) => { await connecting; return reconnect(id, metadata); });
    const users = vi.spyOn(h.stores.delegationStore, "releaseResourceUse");
    const router = h.runner();
    await h.enqueue("chat only");
    void router.handleNewEvent(h.session.id, h.agent);
    await until(async () => (await h.ofType("agent.message")).length === 2);
    await sleep(30);
    expect(await h.ofType("session.turn_completed")).toHaveLength(1);
    expect(users).not.toHaveBeenCalled();
    connected();
    expect(await router.waitForIdle(4000)).toBe(true);
    expect(users).toHaveBeenCalledTimes(1);
    const log = await h.log();
    const second = log.slice(log.findIndex((stored) => stored.type === "session.turn_completed") + 1);
    expect(second.map((stored) => stored.type).filter((type) => type.startsWith("span.sandbox") || type.startsWith("span.skills") || type === "session.turn_completed"))
      .toEqual(["span.sandbox_prepare_start", "span.sandbox_prepare_end", "session.turn_completed"]);
    expect(spansOf(second).map(([, data]) => data)[1]).toMatchObject({ outcome: "ready", sandboxId: h.gateway.created[0] });
    expect(errorCodes(log)).toEqual([]);
    expect(h.errors).toEqual([]);
  });
});

describe("a Runner lost after an environment failure", () => {
  it("leaves the Turn to the takeover, which continues it: an environment ready again records no error", async () => {
    const h = await harness(async (input, write, attempt) => {
      if (attempt === 1) {
        await tool(input, write, "call_1");
        // The Runner is lost before the Turn ends.
        h.lost.add("runner-a");
        await aborted(input.signal!);
        return;
      }
      if (!input.resume) throw new Error("The takeover continues the Turn");
      await tool(input, write, "call_2");
      await answer(write);
    });
    h.gateway.createFault = (step) => { if (step === "claim") throw new SandboxCreateRejected(403); };
    await h.enqueue("write a note");
    await h.runner("runner-a").handleNewEvent(h.session.id, h.agent);
    expect((await h.ofType("agent.tool_result")).map((stored) => stored.data)).toEqual([expect.objectContaining({ toolUseId: "call_1", isError: true })]);
    expect(await h.ofType("session.error")).toEqual([]);
    h.gateway.createFault = undefined;
    await sleep(120); // The lease runs out.

    const takeover = h.runner("runner-b");
    await takeover.handleNewEvent(h.session.id, h.agent);
    expect(await takeover.waitForIdle(4000)).toBe(true);

    expect(h.attempts.map((input) => [input.turnId, input.resume !== undefined])).toEqual([["turn_1_a1", false], ["turn_1_a1", true]]);
    const log = await h.log();
    expect(log.filter((stored) => stored.type === "session.turn_resumed")).toHaveLength(1);
    expect((await h.ofType("agent.tool_result")).map((stored) => [(stored.data as { toolUseId: string }).toolUseId, (stored.data as { isError: boolean }).isError]))
      .toEqual([["call_1", true], ["call_2", false]]);
    expect(errorCodes(log)).toEqual([]);
    expect((await h.ofType("session.turn_completed")).map((stored) => (stored.data as { turnId: string }).turnId)).toEqual(["turn_1_a1"]);
    expect(h.gateway.created).toHaveLength(1);
  });

  it("ends the span of a preparation the lost Runner left running, as aborted, right after the takeover marker", async () => {
    const h = await harness(async (input, write, attempt) => {
      if (input.message.content.some((block) => block.type === "text" && block.text === "create")) { await tool(input, write, "call_0"); await answer(write); return; }
      if (attempt === 2) {
        h.lost.add("runner-a");
        await aborted(input.signal!);
        return;
      }
      await tool(input, write, "call_1");
      await answer(write);
    });
    await h.turn("create");
    // Runner A's connect never returns: it is lost while it runs.
    let connected!: () => void;
    const connecting = new Promise<void>((resolve) => { connected = resolve; });
    const reconnect = h.gateway.reconnect.bind(h.gateway);
    vi.spyOn(h.gateway, "reconnect").mockImplementationOnce(async (id, metadata) => { await connecting; return reconnect(id, metadata); });
    await h.enqueue("use it");
    void h.runner("runner-a").handleNewEvent(h.session.id, h.agent);
    await until(() => h.attempts.length === 2);
    await until(async () => (await h.ofType("span.sandbox_prepare_start")).length === 2);
    await sleep(120);
    const takeover = h.runner("runner-b");
    void takeover.handleNewEvent(h.session.id, h.agent);
    await until(async () => (await h.ofType("session.turn_resumed")).length === 1);
    // The in-memory store serializes a binding's operations across both
    // Runners, as one PostgreSQL store does within one process: the lost
    // Runner's connect ends, writing nothing, before the takeover's runs.
    connected();
    expect(await takeover.waitForIdle(4000)).toBe(true);

    const log = await h.log();
    const turn = log.slice(log.findIndex((stored) => stored.type === "session.turn_completed") + 1);
    const types = turn.map((stored) => stored.type).filter((type) => type.startsWith("span.sandbox") || type === "session.turn_resumed");
    expect(types).toEqual(["span.sandbox_prepare_start", "session.turn_resumed", "span.sandbox_prepare_end",
      "span.sandbox_prepare_start", "span.sandbox_prepare_end"]);
    const [, lostEnd, , end] = spansOf(turn).map(([, data]) => data);
    expect(lostEnd).toEqual({ turnId: expect.any(String), prepareId: "1.1", outcome: "aborted", reason: PREPARE_ATTEMPT_STOPPED });
    expect(end).toMatchObject({ prepareId: "2.1", outcome: "ready" });
    expect(errorCodes(log)).toEqual([]);
    expect((await h.ofType("agent.tool_result")).map((stored) => (stored.data as { isError: boolean }).isError)).toEqual([false, false]);
  });

  it("ends the continued Turn with sandbox_unavailable when its environment never became ready again", async () => {
    const h = await harness(async (input, write, attempt) => {
      if (attempt === 1) {
        await tool(input, write, "call_1");
        h.lost.add("runner-a");
        await aborted(input.signal!);
        return;
      }
      // The takeover answers without a tool: the failure the lost attempt met stands.
      await answer(write, "could not write the note");
    });
    h.gateway.createFault = (step) => { if (step === "claim") throw new SandboxCreateRejected(403); };
    await h.enqueue("write a note");
    await h.runner("runner-a").handleNewEvent(h.session.id, h.agent);
    await sleep(120);
    const takeover = h.runner("runner-b");
    await takeover.handleNewEvent(h.session.id, h.agent);
    expect(await takeover.waitForIdle(4000)).toBe(true);

    expect(h.attempts).toHaveLength(2);
    const log = await h.log();
    expect(errorCodes(log)).toEqual(["sandbox_unavailable"]);
    const types = log.map((stored) => stored.type);
    expect(types.slice(types.indexOf("session.turn_resumed"))).toEqual(expect.arrayContaining(["agent.message", "session.error", "session.turn_completed"]));
    expect(types.indexOf("session.error")).toBeGreaterThan(types.indexOf("session.turn_resumed"));
  });
});
