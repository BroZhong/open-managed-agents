/**
 * A fleet of N Runners over one shared store-memory set, metered in
 * PostgreSQL statements. Each Runner is the production wiring of
 * src/execution.ts (SessionRouter + RunnerDispatch + LoopScheduler at their
 * real defaults) with its own claim owner id, so the Runners compete for
 * input exactly as separate processes sharing one database do.
 *
 * Attribution: every store call is labelled with the activity that made it.
 * An AsyncLocalStorage context follows awaits; timers are labelled where they
 * are created (the heartbeat, claim retry and scan timers), because fake
 * timers fire callbacks outside the context that scheduled them.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createMemoryStores, type MemoryStores } from "@oma-server/store-memory";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { DefaultSandboxManager, FakeSandboxClient } from "@oma-server/sandbox";
import { SessionRouter } from "@oma-server/session-router";
import type { SessionSignal, SessionSignals } from "@oma-server/redis";
import type { Agent, SandboxLifecycleStore, Session } from "@oma-server/store";
import type { Adapter, AdapterInput, SessionEvent, ToolExecutor } from "@open-managed-agents/adapter-core";
import { RunnerDispatch } from "../../src/lib/runner-dispatch.js";
import { LoopScheduler } from "../../src/lib/loop-scheduler.js";
import { pgStatements, type CallFacts, type Statement } from "./pg-statements.js";

// ─── Attribution ─────────────────────────────────────────────────────────────

/** One drain of a Session: attempts until it claims input, a Turn after. */
interface Drain { trigger: string; claimed: boolean }
interface Activity { source: string; drain?: Drain }

const activity = new AsyncLocalStorage<Activity>();

/** Run `work` as `source`; everything it awaits is attributed to it. */
export function as<T>(source: string, work: () => T): T {
  return activity.run({ source }, work);
}

function sourceOf(current: Activity | undefined): string {
  if (!current) return "unattributed";
  if (current.drain) return current.drain.claimed ? "turn" : `attempt <- ${current.drain.trigger}`;
  return current.source;
}

/**
 * Timers whose callbacks start an activity of their own, by the function and
 * file that create them. A renamed function falls back to the creating
 * activity, which shows up as a larger "turn" or "unattributed" share.
 */
const TIMER_SOURCES: Array<{ functions: string[]; file: string; source: string }> = [
  { functions: ["startClaimHeartbeat", "tick"], file: "session-router.ts", source: "heartbeat" },
  { functions: ["scheduleClaimRetry"], file: "session-router.ts", source: "claim-retry" },
  { functions: ["start"], file: "runner-dispatch.ts", source: "dispatch-scan" },
  { functions: ["start"], file: "loop-scheduler.ts", source: "loop-scan" },
];

/** Structured call sites: no stack string formatting or source-map lookups per timer. */
function callSites(): NodeJS.CallSite[] {
  const format = Error.prepareStackTrace;
  Error.prepareStackTrace = (_error, sites) => sites;
  const holder: { stack?: NodeJS.CallSite[] } = {};
  Error.captureStackTrace(holder, callSites);
  const sites = holder.stack ?? [];
  Error.prepareStackTrace = format;
  return sites;
}

function timerSource(): string | undefined {
  for (const site of callSites()) {
    const name = site.getFunctionName();
    const file = site.getFileName() ?? "";
    const match = name && TIMER_SOURCES.find(({ functions, file: owner }) => functions.includes(name) && file.endsWith(owner));
    if (match) return match.source;
  }
  return undefined;
}

/**
 * Wrap the (fake) timer functions so each callback runs in an activity: its
 * own for the timers above, otherwise the one that created it, as Node's real
 * timers propagate AsyncLocalStorage. Returns the uninstaller.
 */
export function labelTimers(): () => void {
  const originalTimeout = globalThis.setTimeout;
  const originalInterval = globalThis.setInterval;
  const bind = (callback: (...args: unknown[]) => void) => {
    const source = timerSource();
    const context = source ? { source } : activity.getStore();
    return (...args: unknown[]) => context ? activity.run(context, () => callback(...args)) : callback(...args);
  };
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    originalTimeout(bind(callback), ms, ...args)) as typeof setTimeout;
  globalThis.setInterval = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    originalInterval(bind(callback), ms, ...args)) as typeof setInterval;
  return () => {
    globalThis.setTimeout = originalTimeout;
    globalThis.setInterval = originalInterval;
  };
}

// ─── Metering ────────────────────────────────────────────────────────────────

export interface CallRecord {
  runner: string;
  source: string;
  method: string;
  statements: Statement[];
  at: number;
  sessionId?: string;
  claimOutcome?: CallFacts["claimOutcome"];
  /** Rows a paginated read returned. */
  rows?: number;
}

export interface TurnSpan { sessionId: string; runner: string; start: number; end?: number }

/** Stores whose methods take the Session id first; delegation methods take other ids. */
const SESSION_KEYED = /^(pendingEventStore|sessionStore|eventLogStore|sandboxLifecycle|sessionCleanup)\./;

const METERED = ["pendingEventStore", "sessionStore", "eventLogStore", "delegationStore",
  "agentStore", "agentFileStore", "skillStore", "loopStore"] as const;
type MeteredStores = Pick<MemoryStores, typeof METERED[number]>;

export class Meter {
  readonly calls: CallRecord[] = [];
  readonly turns: TurnSpan[] = [];
  private readonly openTurns = new Map<string, TurnSpan>();

  constructor(private readonly raw: MemoryStores) {}

  record(runner: string, method: string, facts: CallFacts, source = sourceOf(activity.getStore()), at = Date.now()): void {
    const first = facts.args[0];
    this.calls.push({ runner, source, method, statements: pgStatements(method, facts), at,
      sessionId: SESSION_KEYED.test(method) && typeof first === "string" ? first : undefined, claimOutcome: facts.claimOutcome,
      rows: (facts.result as { data?: unknown[] } | undefined)?.data?.length });
  }

  /** The store set one Runner (or the API) sees: the shared stores, metered under its name. */
  view(runner: string): MeteredStores {
    return Object.fromEntries(METERED.map((name) => [name, this.wrap(runner, name, this.raw[name])])) as unknown as MeteredStores;
  }

  /** The Sandbox lifecycle coordination store, which only PostgreSQL implements. */
  lifecycle(runner: string): SandboxLifecycleStore {
    const record = (method: string, args: unknown[], result?: unknown) =>
      this.record(runner, `sandboxLifecycle.${method}`, { args, result, failed: false });
    return {
      async begin(work) { record("begin", [work.sessionId], true); return true; },
      async finish(work) { record("finish", [work.sessionId]); },
      // The binding is still in use, as for a Child sharing its parent's
      // Sandbox: explicit reclamation is refused and retried later.
      async claimReclamation(bindingId) { record("claimReclamation", [bindingId], null); return null; },
      async completeReclamation(ticket) { record("completeReclamation", [ticket.bindingId]); },
    };
  }

  private wrap<T extends object>(runner: string, store: string, target: T): T {
    const meter = this;
    return new Proxy(target, {
      get(object, property) {
        const value = Reflect.get(object, property, object) as unknown;
        if (typeof value !== "function" || typeof property !== "string") return value;
        const method = `${store}.${property}`;
        return (...args: unknown[]) => {
          const context = activity.getStore();
          const at = Date.now();
          const seqBefore = method === "eventLogStore.append"
            ? meter.raw.eventLogStore.getLatestSeq(args[0] as string) : undefined;
          const settle = async (result: unknown, failed: boolean) => {
            const facts: CallFacts = { args, result, failed };
            if (method === "pendingEventStore.claim" && !failed) {
              facts.claimOutcome = result ? "claimed" : await meter.raw.pendingEventStore.peek(args[0] as string) ? "contended" : "empty";
              if (result && context?.drain) context.drain.claimed = true;
              if (result) meter.openTurn(args[0] as string, runner, at);
            }
            if (method === "eventLogStore.append" && !failed) {
              facts.appendedNewRow = (result as { seq: number }).seq > await seqBefore!;
            }
            if (method === "pendingEventStore.ackCompletedTurn" && (result as { acknowledged?: boolean })?.acknowledged) {
              meter.closeTurn(args[0] as string, Date.now());
            }
            meter.record(runner, method, facts, sourceOf(context), at);
          };
          const result = (value as (...a: unknown[]) => unknown).apply(object, args);
          if (!(result instanceof Promise)) { void settle(result, false); return result; }
          return result.then(async (resolved) => { await settle(resolved, false); return resolved; },
            async (error) => { await settle(undefined, true); throw error; });
        };
      },
    });
  }

  private openTurn(sessionId: string, runner: string, at: number): void {
    const span = { sessionId, runner, start: at };
    this.openTurns.set(sessionId, span);
    this.turns.push(span);
  }

  private closeTurn(sessionId: string, at: number): void {
    const span = this.openTurns.get(sessionId);
    if (span) span.end = at;
    this.openTurns.delete(sessionId);
  }
}

// ─── Infrastructure doubles ──────────────────────────────────────────────────

/** Redis pub/sub in one process: every Runner's subscription sees every wake. */
class InMemorySignals implements SessionSignals {
  private readonly listeners = new Set<(signal: SessionSignal) => void>();
  publish(signal: SessionSignal): void {
    const origin = sourceOf(activity.getStore());
    for (const listener of this.listeners) activity.run({ source: `wake <- ${origin}` }, () => listener(signal));
  }
  subscribe(listener: (signal: SessionSignal) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

/** PgSessionCleanupStore's outbox: discovery, SKIP LOCKED attempt, 5 s retry. */
class CleanupOutbox {
  private readonly rows = new Map<string, { retryAt: number; done: boolean; locked: boolean }>();
  add(sessionId: string): void { this.rows.set(sessionId, { retryAt: Date.now(), done: false, locked: false }); }
  sweeper(meter: Meter, runner: string, cleanup: (sessionId: string) => Promise<boolean>): () => Promise<void> {
    return () => as("cleanup-sweep", async () => {
      meter.record(runner, "sessionCleanup.discover", { args: [], result: undefined, failed: false });
      const due = [...this.rows].filter(([, row]) => !row.done && row.retryAt <= Date.now())
        .sort(([, a], [, b]) => a.retryAt - b.retryAt).slice(0, 25);
      for (const [sessionId, row] of due) {
        // Another Runner holds the row, or already rescheduled it: SKIP LOCKED finds nothing.
        const skipped = row.locked || row.done || row.retryAt > Date.now();
        meter.record(runner, skipped ? "sessionCleanup.skip" : "sessionCleanup.attempt", { args: [sessionId], result: undefined, failed: false });
        if (skipped) continue;
        row.locked = true;
        try { row.done = await cleanup(sessionId); } catch { row.done = false; }
        row.retryAt = Date.now() + 5_000;
        row.locked = false;
      }
    });
  }
}

// ─── Scripted Adapter ────────────────────────────────────────────────────────

/**
 * The shape of one Turn: Pi-like native entries, one model request per step,
 * every tool call touching the Sandbox through the fenced executor. Defaults
 * reproduce the oma-test averages (≈55 durable events and ≈6 minutes per
 * input, see docs/verification/db-load-multi-runner-2026-10-22.md).
 */
export interface TurnShape {
  steps: number;
  modelMs: number;
  toolMs: number;
  sandboxOpsPerTool: number;
  /** The tool call of this step is a synchronous Agent delegation. */
  delegateAtStep?: number;
  child?: TurnShape;
}

export const OMA_TEST_TURN: TurnShape = { steps: 12, modelMs: 3_000, toolMs: 25_000, sandboxOpsPerTool: 2 };

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

function event(type: string, data: object): SessionEvent {
  return { id: randomUUID(), timestamp: new Date().toISOString(), type, ...data } as SessionEvent;
}

function native(turnId: string, message: object, blocks: object[]): SessionEvent {
  return event("agent.context_entry", { sdk: "pi@0.83.0", turnId,
    entry: { id: randomUUID(), type: "message", parentId: null, message }, presentation: { version: 1, blocks } });
}

async function touchSandbox(executor: ToolExecutor, operations: number): Promise<void> {
  for (let operation = 0; operation < operations; operation++) {
    if (operation % 2 === 0) for await (const _chunk of executor.exec(["echo", "ok"])) { /* drain */ }
    else await executor.writeFile("notes.txt", "ok");
  }
}

/**
 * Written against the Adapter contract at 85f2a69 (events are yielded and
 * the Router flushes each Complete Event). When #244 moves Adapters to the
 * injected journal, only this function changes.
 */
export function scriptedAdapter(parent: TurnShape): Adapter {
  return {
    async *run(input: AdapterInput) {
      const shape = input.execution?.isChild ? parent.child! : parent;
      const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
      // Pi resolves its configuration once, then checks steering before every model request.
      await input.execution?.onResolved?.({ model: input.agent.model, thinking: "off", thinkingSource: "agent" });
      yield event("agent.context_start", { sdk: "pi@0.83.0", turnId: input.turnId, inputEventId: input.inputEventId });
      for (let step = 0; step <= shape.steps; step++) {
        await input.execution?.steering?.takePending();
        yield event("span.model_request_start", { model: input.agent.model });
        await sleep(shape.modelMs, input.signal);
        if (step === shape.steps) {
          yield native(input.turnId, { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }, [{ type: "agent.message", index: 0 }]);
          yield event("span.model_request_end", { usage });
          return;
        }
        const toolUseId = `call_${randomUUID()}`;
        const delegating = shape.delegateAtStep === step && input.subagents !== undefined;
        const toolName = delegating ? "Agent" : "bash";
        yield native(input.turnId, { role: "assistant", content: [{ type: "toolCall", id: toolUseId, name: toolName, arguments: {} }], stopReason: "toolUse" },
          [{ type: "agent.tool_use", index: 0 }]);
        yield event("span.model_request_end", { usage });
        let output: unknown = "ok";
        if (delegating) {
          output = await as("delegation-wait", () => input.subagents!.delegate({ prompt: "child", runInBackground: false }, { toolUseId }));
        } else {
          await as("tool-op", () => touchSandbox(input.toolExecutor!, shape.sandboxOpsPerTool));
          await sleep(shape.toolMs, input.signal);
        }
        yield native(input.turnId, { role: "toolResult", toolCallId: toolUseId, toolName, content: [{ type: "text", text: JSON.stringify(output) }], isError: false },
          [{ type: "agent.tool_result" }]);
      }
    },
  };
}

// ─── Fleet ───────────────────────────────────────────────────────────────────

const WORKSPACE_MOUNT = { bucket: "agentry", agentName: "agentry-workspace", pvName: "agentry-workspace-oss", credentialProviderName: "agentry-oss-rw" };

export interface Runner { name: string; router: SessionRouter; dispatch: RunnerDispatch; loops: LoopScheduler }

export class Fleet {
  readonly raw = createMemoryStores();
  readonly meter = new Meter(this.raw);
  readonly errors: unknown[] = [];
  readonly runners: Runner[] = [];
  private readonly sandboxClient = new FakeSandboxClient();
  private readonly signals = new InMemorySignals();
  private readonly outbox = new CleanupOutbox();
  private readonly api = this.meter.view("api");
  private agent!: Agent;
  private workspaceId!: string;

  constructor(private readonly count: number, private readonly shape: TurnShape) {}

  async start(): Promise<void> {
    this.agent = await this.raw.agentStore.create({ tenantId: "tenant", name: "Load", model: "test/model", system: "load",
      runtime: "pi-agent", sandbox: { enabled: true } });
    this.workspaceId = (await this.raw.workspaceStore.create({ tenantId: "tenant" })).id;
    const adapter = scriptedAdapter(this.shape);
    for (let index = 0; index < this.count; index++) {
      const name = `runner-${index}`;
      const stores = this.meter.view(name);
      const router = new SessionRouter({
        ...stores, skillArtifactStore: this.raw.skillArtifactStore,
        eventStreamHub: new InProcessEventStreamHub(), resolveAdapter: () => adapter,
        sandboxManager: new DefaultSandboxManager({ sandboxClient: this.sandboxClient, provisionSources: {}, lifecycle: this.meter.lifecycle(name) }),
        workspaceMount: WORKSPACE_MOUNT, pendingClaimOwnerId: name,
        wakeSession: (sessionId) => this.signals.publish({ sessionId, kind: "wake" }),
        onDrainError: ({ error }) => this.errors.push(error),
      });
      instrument(router);
      const dispatch = new RunnerDispatch({ router, sessions: stores.sessionStore, signals: this.signals,
        cleanup: this.outbox.sweeper(this.meter, name, (sessionId) => router.cleanupTerminatedSession(sessionId)) });
      const loops = new LoopScheduler({ loopStore: stores.loopStore, sessionRouter: router, logger: { error: () => {} } });
      this.runners.push({ name, router, dispatch, loops });
    }
    await as("startup", async () => {
      for (const runner of this.runners) { await runner.dispatch.start(); runner.loops.start(); }
    });
  }

  async createSession(): Promise<Session> {
    return this.raw.sessionStore.create({ tenantId: "tenant", agentId: this.agent.id, agent: this.agent, workspaceId: this.workspaceId });
  }

  /** The API's half of a user message: durable enqueue, then a best-effort wake of every Runner. */
  async send(sessionId: string): Promise<void> {
    await as("api", async () => {
      await this.api.pendingEventStore.enqueue(sessionId, { type: "user.message",
        data: { content: [{ type: "text", text: "go" }] }, sessionThreadId: "sthr_primary" });
      this.signals.publish({ sessionId, kind: "wake" });
    });
  }

  /** Termination as the API commits it: revoke input and record the cleanup outbox row. */
  async terminate(sessionId: string): Promise<void> {
    await this.raw.sessionStore.terminate(sessionId);
    await this.raw.pendingEventStore.clear(sessionId);
    this.outbox.add(sessionId);
  }

  async completedTurns(sessionId: string): Promise<number> {
    const { data } = await this.raw.eventLogStore.getEvents(sessionId, { limit: 10_000 });
    return data.filter((stored) => stored.type === "session.turn_completed").length;
  }

  async stop(): Promise<void> {
    await Promise.all(this.runners.map(({ dispatch, loops }) => Promise.all([dispatch.stop(), loops.stop()])));
  }
}

/** Give each drain of a Session its own activity, named after what triggered it. */
function instrument(router: SessionRouter): void {
  const handle = router.handleNewEvent.bind(router);
  router.handleNewEvent = (sessionId: string, agent: Agent) => {
    const parent = activity.getStore();
    const trigger = !parent ? "direct" : parent.drain ? (parent.drain.claimed ? "turn handoff" : parent.drain.trigger) : parent.source;
    return activity.run({ source: trigger, drain: { trigger, claimed: false } }, () => handle(sessionId, agent));
  };
}

// ─── Virtual time ────────────────────────────────────────────────────────────

/**
 * Advance fake time in small steps, letting every promise chain settle in
 * between. A timer fires at most `stepMs` late, so a 1 s heartbeat is
 * measured within 2 % and the 200 ms delegation poll within 10 %.
 */
export async function advance(ms: number, advanceTimers: (ms: number) => void, stepMs = 20): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
    advanceTimers(Math.min(stepMs, ms - elapsed));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

// ─── Summaries ───────────────────────────────────────────────────────────────

export interface SourceTotals { calls: number; statements: number; methods: Map<string, { calls: number; statements: number }> }

export function bySource(calls: CallRecord[]): Map<string, SourceTotals> {
  const totals = new Map<string, SourceTotals>();
  for (const call of calls) {
    const source = totals.get(call.source) ?? { calls: 0, statements: 0, methods: new Map() };
    source.calls++;
    source.statements += call.statements.length;
    const method = source.methods.get(call.method) ?? { calls: 0, statements: 0 };
    method.calls++;
    method.statements += call.statements.length;
    source.methods.set(call.method, method);
    totals.set(call.source, source);
  }
  return totals;
}

/** Statements that scan a whole table, by table: "seq" for lack of an index, "full" by design. */
export function seqScans(calls: CallRecord[]): Map<string, number> {
  const tables = new Map<string, number>();
  for (const call of calls) for (const statement of call.statements) {
    if (statement.access !== "seq" && statement.access !== "full") continue;
    const name = `${statement.table}${statement.access === "full" ? " (full by design)" : ""}`;
    tables.set(name, (tables.get(name) ?? 0) + 1);
  }
  return tables;
}

export const statementCount = (calls: CallRecord[]) => calls.reduce((sum, call) => sum + call.statements.length, 0);
