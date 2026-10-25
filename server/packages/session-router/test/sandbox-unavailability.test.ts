import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createMemoryStores } from "@oma-server/store-memory";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { DefaultSandboxManager, DefaultTurnSandboxes, FakeSandboxClient, SandboxCreateRejected } from "@oma-server/sandbox";
import { presentEvent, type StoredEvent } from "@oma-server/store";
import { ExecutorUnavailableError, type Adapter, type AdapterInput, type SessionEvent } from "@open-managed-agents/adapter-core";
import { journalWriter } from "@open-managed-agents/adapter-mock";
import { SessionRouter } from "../src/session-router.js";
import { PREPARE_ATTEMPT_STOPPED } from "../src/sandbox-prepare-spans.js";

/**
 * A Sandbox unavailability is a tool error, not the end of the Turn
 * (ADR-0023, #287): the Turn runs on, records each preparation as a span, and
 * only its end records `sandbox_unavailable`, when its Sandbox never became
 * ready again. Real Sandbox Manager and Turn Sandboxes over a fake gateway.
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
async function harness(script: Script, claims: { poolImage?: string; sandboxImage?: string; environmentImage?: string;
  environmentVariables?: Record<string, string> } = {}) {
  const stores = createMemoryStores();
  // The Session's Environment, built, when the test names its image (ADR-0024).
  const environment = claims.environmentImage === undefined ? undefined : await stores.environmentStore.create({
    id: "env_tools", owner: { ownerType: "tenant", tenantId: "tenant" }, name: "tools", description: "", baseImage: "oma-base",
    initScript: "", env: [], encryptedSecrets: {} });
  if (environment) stores.environmentStore.succeedBuild(environment.id, claims.environmentImage!);
  const agent = await stores.agentStore.create({ tenantId: "tenant", name: "Test", model: "test", system: "test",
    runtime: "pi-agent", sandbox: { enabled: true }, environmentId: environment?.id });
  const workspace = await stores.workspaceStore.create({ tenantId: "tenant" });
  const session = await stores.sessionStore.create({ tenantId: "tenant", agentId: agent.id, agent, workspaceId: workspace.id,
    environmentId: environment?.id });
  const gateway = new FakeSandboxClient({ poolImage: claims.poolImage });
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
      bindings: stores.delegationStore, sessions: stores.sessionStore, workspaceMount, sandboxImage: claims.sandboxImage,
      // The Host's resolution, here of plain values only (the Runner's opens secrets too).
      environments: {
        image: async (tenantId, id) => (await stores.environmentStore.getForSandbox(tenantId, id))?.image ?? null,
        variables: async () => ({ ...claims.environmentVariables }),
      },
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

/**
 * A tool call through the Turn's executor, its result recorded as Pi records
 * it: a native toolResult entry, an error the model sees whose details carry
 * a Sandbox unavailability's code.
 */
async function tool(input: AdapterInput, write: Write, id: string): Promise<unknown> {
  await write(event("agent.tool_use", { toolUseId: id, name: "write", input: { path: "note.txt" } }));
  const result = (text: string, error?: unknown) => write(event("agent.context_entry", { sdk: "pi@0.83.0",
    entry: { type: "message", id: `entry_${id}`, parentId: null, timestamp: new Date().toISOString(), message: {
      role: "toolResult", toolCallId: id, toolName: "write", content: [{ type: "text", text }], isError: error !== undefined,
      ...(error instanceof ExecutorUnavailableError ? { details: { ...error.details, code: error.code } } : {}), timestamp: Date.now() } },
    presentation: { version: 1, blocks: [{ type: "agent.tool_result" }] } }));
  try {
    await input.toolExecutor!.writeFile("note.txt", id);
    await result("written");
    return undefined;
  } catch (error) {
    await result((error as Error).message, error);
    return error;
  }
}
const answer = (write: Write, text = "done") => write(event("agent.message", { content: [{ type: "text", text }] }));
/** Each tool call's result, as the Session's events display it. */
const results = (log: StoredEvent[]) => log.flatMap((stored) => presentEvent(stored)).filter((shown) => shown.type === "agent.tool_result")
  .map((shown) => shown.data as { toolUseId: string; isError: boolean });
const spansOf = (log: StoredEvent[]) => log.filter((stored) => stored.type.startsWith("span.sandbox_prepare_"))
  .map((stored) => [stored.type, stored.data]);
const errorCodes = (log: StoredEvent[]) => log.filter((stored) => stored.type === "session.error")
  .map((stored) => (stored.data as { error: { code: string } }).error.code);

describe("a Turn's preparation records its Warm Pool claim (ADR-0024)", () => {
  const POOL = "registry.example/welltop/oma-sandbox@sha256:" + "6".repeat(64);
  const OTHER = "registry.example/welltop/oma-environments@sha256:" + "7".repeat(64);

  it.each([[POOL, false], [OTHER, true]])("claims with the configured image %s (swapped %s); a later Turn's connect claims nothing", async (image, swapped) => {
    const h = await harness(async (input, write) => {
      await tool(input, write, `call_${input.turnId}`);
      await answer(write);
    }, { poolImage: POOL, sandboxImage: image });
    await h.turn("write a note");
    await h.turn("write another");
    expect(h.gateway.createOptsOf(h.gateway.created[0]).image).toBe(image);
    expect(h.gateway.created).toHaveLength(1);
    expect(spansOf(await h.log()).filter(([type]) => type === "span.sandbox_prepare_end")).toEqual([
      ["span.sandbox_prepare_end", { turnId: "turn_1_a1", prepareId: "1.1", outcome: "ready", sandboxId: h.gateway.created[0],
        image, swapped, claimMs: 0, durationMs: expect.any(Number) }],
      ["span.sandbox_prepare_end", { turnId: expect.not.stringMatching(/^turn_1_/), prepareId: "1.1", outcome: "ready", sandboxId: h.gateway.created[0],
        durationMs: expect.any(Number) }],
    ]);
    expect(h.errors).toEqual([]);
  });

  it("runs a Session's commands with its Environment's variables, which reach no event, no command line and not the Sandbox's creation", async () => {
    const CANARY = "sk-canary-" + "7d1e".repeat(8);
    const h = await harness(async (input, write) => {
      await write(event("agent.tool_use", { toolUseId: "call_deploy", name: "bash", input: { command: "deploy-tool --dry-run" } }));
      for await (const _ of input.toolExecutor!.exec(["deploy-tool", "--dry-run"])) { /* drain */ }
      await answer(write);
    }, { sandboxImage: POOL, environmentImage: OTHER, environmentVariables: { API_TOKEN: CANARY } });
    await h.turn("deploy");
    const [sandboxId] = h.gateway.created;
    const command = h.gateway.execs.find((run) => run.command[0] === "deploy-tool")!;
    expect(command.env).toMatchObject({ API_TOKEN: CANARY, HOME: "/home/user" });
    expect(command.command.join(" ")).not.toContain(CANARY);
    expect(JSON.stringify(await h.log())).not.toContain(CANARY);
    expect(JSON.stringify(h.gateway.createOptsOf(sandboxId))).not.toContain(CANARY);
    expect(h.errors).toEqual([]);
  });

  it("claims a Session's Sandbox with its Environment's image, and the span and the binding name the Environment", async () => {
    const h = await harness(async (input, write) => {
      await tool(input, write, `call_${input.turnId}`);
      await answer(write);
    }, { poolImage: POOL, sandboxImage: POOL, environmentImage: OTHER });
    await h.turn("write a note");
    const [sandboxId] = h.gateway.created;
    expect(h.gateway.createOptsOf(sandboxId).image).toBe(OTHER);
    expect(spansOf(await h.log()).filter(([type]) => type === "span.sandbox_prepare_end")).toEqual([
      ["span.sandbox_prepare_end", { turnId: "turn_1_a1", prepareId: "1.1", outcome: "ready", sandboxId,
        environmentId: "env_tools", image: OTHER, swapped: true, claimMs: 0, durationMs: expect.any(Number) }],
    ]);
    expect(await h.stores.delegationStore.withBindingLock(h.session.id, async (row) => ({ value: row })))
      .toMatchObject({ sandboxId, environmentId: "env_tools", image: OTHER });
    expect(h.errors).toEqual([]);
  });
});

describe("a Sandbox unavailability is a tool error (ADR-0023)", () => {
  it("runs a Turn whose Sandbox is never available to its answer, and ends it with one sandbox_unavailable", async () => {
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
      "agent.tool_use", "span.sandbox_prepare_start", "span.sandbox_prepare_end", "agent.context_entry",
      "agent.tool_use", "span.sandbox_prepare_start", "span.sandbox_prepare_end", "agent.context_entry",
      "agent.message", "session.error", "session.turn_completed"]);
    expect(results(turn)).toEqual(["call_1", "call_2"].map((toolUseId) => expect.objectContaining({ toolUseId, isError: true })));
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

    // The next Turn, whose Sandbox works again, records no error.
    h.gateway.createFault = undefined;
    await h.turn("again");
    expect(errorCodes(await h.log())).toEqual(["sandbox_unavailable"]);
  });

  it("records no error for a Turn whose Sandbox was unavailable once and then became ready", async () => {
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

describe("a failed preparation no tool call waited for", () => {
  it("shows in the span of a pure-chat Turn whose Turn-start connect failed, which records no error; a Turn whose tool met it does", async () => {
    const h = await harness(async (input, write) => {
      if (!input.message.content.some((block) => block.type === "text" && block.text === "chat only")) await tool(input, write, `call_${h.attempts.length}`);
      await answer(write);
    });
    await h.turn("create");
    // The binding is Ready; its Sandbox can no longer be reached.
    vi.spyOn(h.gateway, "reconnect").mockRejectedValue(new Error("gateway unreachable"));
    await h.turn("chat only");
    let log = await h.log();
    const chat = log.slice(log.map((stored) => stored.type).lastIndexOf("session.status_running"));
    expect(spansOf(chat)).toEqual([
      ["span.sandbox_prepare_start", { turnId: expect.any(String), prepareId: "1.1" }],
      ["span.sandbox_prepare_end", { turnId: expect.any(String), prepareId: "1.1", outcome: "failed", code: "sandbox_unavailable", reason: "unreachable", durationMs: expect.any(Number) }],
    ]);
    expect(errorCodes(log)).toEqual([]);
    expect(chat.map((stored) => stored.type).filter((type) => type.startsWith("session.") || type === "agent.message"))
      .toEqual(["session.status_running", "agent.message", "session.turn_completed", "session.status_idle"]);

    await h.turn("write a note");
    log = await h.log();
    expect(results(log).at(-1)).toMatchObject({ toolUseId: "call_3", isError: true });
    expect(errorCodes(log)).toEqual(["sandbox_unavailable"]);
    const completed = (await h.ofType("session.turn_completed")).map((stored) => (stored.data as { turnId: string }).turnId);
    expect((await h.ofType("session.error"))[0].data).toMatchObject({ turnId: completed[2] });
    expect(h.errors).toEqual([]);
  });
});

describe("a Runner lost after a Sandbox unavailability", () => {
  it("leaves the Turn to the takeover, which continues it: a Sandbox ready again records no error", async () => {
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
    expect(results(await h.log())).toEqual([expect.objectContaining({ toolUseId: "call_1", isError: true })]);
    expect(await h.ofType("session.error")).toEqual([]);
    h.gateway.createFault = undefined;
    await sleep(120); // The lease runs out.

    const takeover = h.runner("runner-b");
    await takeover.handleNewEvent(h.session.id, h.agent);
    expect(await takeover.waitForIdle(4000)).toBe(true);

    expect(h.attempts.map((input) => [input.turnId, input.resume !== undefined])).toEqual([["turn_1_a1", false], ["turn_1_a1", true]]);
    const log = await h.log();
    expect(log.filter((stored) => stored.type === "session.turn_resumed")).toHaveLength(1);
    expect(results(log).map(({ toolUseId, isError }) => [toolUseId, isError])).toEqual([["call_1", true], ["call_2", false]]);
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
    expect(results(log).map(({ isError }) => isError)).toEqual([false, false]);
  });

  it("ends the continued Turn with sandbox_unavailable when its Sandbox never became ready again", async () => {
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
