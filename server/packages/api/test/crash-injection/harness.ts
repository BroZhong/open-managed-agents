import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { createMemoryStores, type MemoryStores } from "@oma-server/store-memory";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { BestEffortTurnStreamStore, InMemoryTurnStreamStore, type TurnDelta, type TurnStreamStore } from "@oma-server/redis";
import type { SandboxManager, SandboxSession } from "@oma-server/sandbox";
import { SessionRouter } from "@oma-server/session-router";
import { presentEvent, type DelegationCommand, type DelegationExecution, type PendingEventClaim, type PendingEventClaimEnd, type StoredEvent } from "@oma-server/store";
import type { Adapter, AdapterInput, ExecOptions, ToolFileSystem } from "@open-managed-agents/adapter-core";
import { PiAgentAdapter, registerCustomProvider, type CustomProviderDefinition } from "@open-managed-agents/adapter-pi-agent";

/**
 * Crash injection (#248): a Session's Turns run through real Routers, the real
 * Pi SDK, a scripted model and scripted Sandbox tools, over one in-memory
 * store that outlives every Runner. A Runner is lost the way kill -9 loses
 * it: right after its Nth durable write it stops at once (every store call,
 * model request and tool command it makes from then on never settles, so
 * none of its cleanup runs) and its claim lapses. The next Runner takes over
 * as a Runner's pending scan does. A sweep loses the first Runner after each
 * write the scenario makes, one run per write. A Runner can instead be shut
 * down as SIGTERM shuts it down (#254): its Router hands its Turns over, then
 * its process exits. A scenario can also make the event log refuse a write,
 * which stops the attempt and lets its claim lapse.
 *
 * A scenario that delegates runs its Child Sessions on the Runner that runs
 * their parent, so one loss loses both, or `apart`, on Runners of their own:
 * each Runner then stands for one role, parent or child, and a lost one is
 * replaced in its role. Wakes and check hints travel between Runners as
 * RunnerDispatch carries them.
 */

/** How a takeover's result for a call of unknown outcome begins (#248). */
export const OUTCOME_UNKNOWN_PREFIX = "The agent runtime restarted while this tool call was in progress";

type Json = Record<string, unknown>;
/** A block of a scripted model response, in Anthropic Messages form. */
export type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Json };

/** One model request as the scripted provider received it. */
export interface ModelRequest {
  /** Its position among the execution's model requests, from 0. */
  index: number;
  /** Pi's compaction summary request, which is not a model step. */
  summary: boolean;
  /** The text of the request's last user message. */
  lastUser: string;
  /** The request's messages, serialized, for checks by substring. */
  text: string;
  /** Results the request carries, by call id. */
  results: Map<string, { isError: boolean; text: string }>;
  /** The Runner that sent it. */
  runner: number;
  /** The model the request names, as the provider sees it (without the provider). */
  model: string;
  /** The request's thinking parameter, as the provider sees it. */
  thinking: unknown;
  /** The request's system prompt, serialized, for checks by substring. */
  system: string;
}

export type ModelReply =
  /**
   * `lostMidStream`: stream the first block's first half, wait until its
   * Delta has left, then lose the Runner while the request is in flight.
   */
  | { blocks: Block[]; stop: "end_turn" | "tool_use"; inputTokens?: number; lostMidStream?: boolean }
  | { error: { status: number; type: string; message: string } };

export interface ToolCall { runner: number; id: string; name: string; args: Json }

export interface Scenario {
  /** User messages queued before the first Runner starts, in order. */
  inputs: string[];
  /** The model, as a function of the request it receives. */
  model(request: ModelRequest, run: Run): ModelReply | Promise<ModelReply>;
  /** A Sandbox tool call's output text; it may lose its Runner while it runs. */
  tool?(call: ToolCall, run: Run): string | Promise<string>;
  /**
   * Whether the event log refuses to store `event`, as PostgreSQL refuses a
   * row it cannot store: the Runner's write fails with {@link RefusedWrite}.
   */
  refuse?(event: { type: string; data: unknown }, run: Run): boolean;
  /** The scripted model's context window; small windows make Pi compact. */
  contextWindow?: number;
  /** session.error codes the scenario's Turns may end with. */
  errors?: string[];
  /** What happens while no Runner executes the Session: after a Runner is lost, before the next one takes over. */
  afterLoss?(run: Run): void | Promise<void>;
  /**
   * Where Child Sessions run: on the Runner that runs their parent, so a
   * loss loses both (the default), or on Runners of their own (#252).
   */
  children?: "together" | "apart";
  /** The Host's model step budget of each Child execution. */
  childSteps?: number;
  /** The parent's limit of concurrently running Child executions. */
  maxChildren?: number;
  /**
   * The user stops every Turn a Runner holds right before the Runner is lost:
   * the API accepts the Interrupt under the Runner's live claim, and the
   * Runner dies before it sees it (D1).
   */
  interruptOnLoss?: boolean;
  /** Whether Redis is unavailable to a Runner: each of its Delta and active-Turn calls fails, as a dropped connection fails them (G3). */
  redisDown?(runner: number): boolean;
  /** The models the scripted provider offers a Runner; all of {@link MODELS} by default. */
  models?(runner: number): readonly string[];
}

/** A Runner's part in a scenario whose Child Sessions run apart. */
export type Role = "parent" | "child";

/** One Session of an execution: the scenario's own, then each Child Session in creation order. */
export interface SessionOutcome {
  id: string;
  /** Its inputs in order: the scenario's for the root, each execution's prompt for a Child Session. */
  inputs: string[];
  log: StoredEvent[];
}

/** What one execution of a scenario produced, for assertions. */
export interface Outcome {
  /** The scenario's Session's log. */
  log: StoredEvent[];
  sessionId: string;
  /** Every Session, the scenario's first. */
  sessions: SessionOutcome[];
  /** Every Delegation Execution, as it ended. */
  executions: DelegationExecution[];
  /** The stores every Runner shared, as the last one left them. */
  stores: MemoryStores;
  runners: Runner[];
  requests: ModelRequest[];
  toolCalls: ToolCall[];
  /** Each Adapter run, with the log as it was when the run started. */
  attempts: Array<{ runner: number; input: AdapterInput; log: StoredEvent[] }>;
  /**
   * What each Runner left as it stopped executing a Session, lost or shut
   * down: the input it held or handed over and the calls without a result.
   */
  losses: Loss[];
  /** Every command a Runner sent the Sandbox, in order. */
  commands: Array<{ runner: number; command: string[] }>;
  errors: Array<{ runner: number; error: unknown }>;
  /** Every Delta any Runner streamed, in order. */
  deltas: TurnDelta[];
  /** Every Sandbox a Runner disposed, by that Runner. */
  disposals: number[];
}

/** What a lost Runner left of one Session whose claim it held, or that it held none. */
export interface Loss {
  runner: number;
  /**
   * How its claim ended: it lapsed (`expired`), as a lost Runner's does and a
   * Runner's stopped by a failed write, or the Runner handed the Turn over
   * (`released`).
   */
  reason: PendingEventClaimEnd;
  /** The Session of the claim; undefined when the Runner held none. */
  sessionId?: string;
  /** The input whose claim the Runner held, by its position in its Session's inputs; undefined when it held none. */
  input?: number;
  generation?: number;
  /** The input's Turn was already completed: the next claim only acknowledges it. */
  completed?: boolean;
  dangling: string[];
  /** A handoff's grace period ran out while the Turn still ran, so it was detached. */
  detached?: boolean;
}

export interface Run {
  /** Lose the Runner that is executing now, as if its process were killed. */
  crash(): void;
  /**
   * SIGTERM the Runner that is executing now (#254): its Router hands its
   * Turns over within `graceMs` (the deployment's 20 s by default), then its
   * process exits.
   */
  shutDown(graceMs?: number): void;
  /** Lose the live Runner of a role, as if its process were killed. */
  lose(role: Role): void;
  /** Accept an Interrupt for a Session's running Turn (the scenario's by default), as the API does, without its hint. */
  requestInterrupt(sessionId?: string): Promise<boolean>;
  /** Accept an Interrupt for a Session's running Turn and hint its owner, as the API does. */
  interrupt(sessionId: string): Promise<boolean>;
  /** A Session's durable log as it is now; the scenario's by default. */
  log(sessionId?: string): Promise<StoredEvent[]>;
  /** The Delegation Executions the scenario's Session created, as they are now. */
  executions(): Promise<DelegationExecution[]>;
  /** Send the scenario's Session one more user message, as the API accepts it; it becomes the Session's last input. */
  send(text: string): Promise<void>;
  /**
   * Terminate the scenario's Session as the API does: PostgreSQL ends it and
   * removes its queued input in one transaction, which fences every later
   * write of whoever executes it.
   */
  terminate(): Promise<void>;
  readonly runner: number;
  /** The stores as the API reaches them, for edits a user makes meanwhile; no Runner's loss affects them. */
  readonly stores: MemoryStores;
  readonly agentId: string;
  readonly sessionId: string;
}

/** The failure of a write the scenario made the event log refuse. */
export class RefusedWrite extends Error {}

/** A store result or command that never settles: the process that awaited it is gone. */
const GONE = new Promise<never>(() => {});

/**
 * Durable writes, by store and method. A claim that finds no head, a start
 * that finds no free slot and a reconciliation that finds nothing write nothing.
 */
const WRITES: Record<string, readonly string[]> = {
  eventLogStore: ["append"],
  pendingEventStore: ["claim", "releaseClaim", "ackCompletedTurn"],
  sessionStore: ["updateStatusIfClaimed"],
  // Every coordination record of a delegation scenario's Turns.
  delegationStore: ["accept", "startExecution", "updateEffectiveConfig", "saveWait", "consumeResult", "cancelWaits",
    "command", "applyCommand", "finishExecution", "markNotificationProcessed", "acquireResourceUse", "releaseResourceUse",
    "reconcileTerminatedExecutions"],
};
const writesNothing = (method: string, result: unknown) => result === null || (method === "reconcileTerminatedExecutions" && Array.isArray(result) && !result.length);

export interface Write { store: string; method: string; args: unknown[]; result: unknown }

/** When a Runner is lost: right after its Nth durable write, or right after the first write a predicate picks. */
export type LoseAfter = number | ((write: Write) => boolean);

/** One Runner process: its writes, and its loss. */
export class Runner {
  dead = false;
  /** Its Router's handoff, once the Runner is shut down; the process exits when it is done. */
  handingOff?: Promise<boolean>;
  /** Shuts the Runner down; set once its Router exists. */
  shutDown?: () => void;
  readonly writes: Write[] = [];
  readonly died: Promise<void>;
  private markDied!: () => void;

  constructor(
    readonly index: number,
    private readonly loseAfter: LoseAfter | undefined,
    private readonly onLoss: (runner: Runner) => void,
    /** Whether the store refuses the call; the call then fails with {@link RefusedWrite}. */
    private readonly refuses: (store: string, method: string, args: unknown[]) => boolean = () => false,
    /** Shut the Runner down right after its Nth durable write. */
    private readonly shutDownAfter?: number,
  ) {
    this.died = new Promise((resolve) => { this.markDied = resolve; });
  }

  get ownerId(): string { return `runner-${this.index}`; }

  lose(): void {
    if (this.dead) return;
    this.dead = true;
    this.onLoss(this);
    this.markDied();
  }

  /** The process exits once its shutdown is done: it holds no claim, and nothing it still awaits settles. */
  exit(): void {
    if (this.dead) return;
    this.dead = true;
    this.markDied();
  }

  /** Called with each durable write once it is committed; the Runner may be lost or shut down right after it. */
  wrote(write: Write): boolean {
    this.writes.push(write);
    if (typeof this.loseAfter === "function" ? this.loseAfter(write) : this.writes.length === this.loseAfter) this.lose();
    if (this.writes.length === this.shutDownAfter) this.shutDown?.();
    return this.dead;
  }

  /** Every store as this Runner reaches it. */
  stores<T extends object>(stores: T): T {
    return Object.fromEntries(Object.entries(stores).map(([name, store]) =>
      [name, store && typeof store === "object" ? this.store(name, store as object) : store])) as T;
  }

  private store(name: string, store: object): object {
    const runner = this;
    return new Proxy(store, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (runner.dead) return GONE;
          if (runner.refuses(name, String(property), args)) return Promise.reject(new RefusedWrite(`${name}.${String(property)} refused`));
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          if (!(result instanceof Promise)) return result;
          const counted = WRITES[name]?.includes(String(property));
          return result.then(
            (settled) => {
              if (runner.dead) return GONE;
              if (!counted || writesNothing(String(property), settled)) return settled;
              return runner.wrote({ store: name, method: String(property), args, result: settled }) ? GONE : settled;
            },
            (error) => runner.dead ? GONE : Promise.reject(error),
          );
        };
      },
    });
  }
}

/** One Anthropic Messages response as server-sent events, streaming each block. */
function sseEvents(blocks: Block[], stop: string, inputTokens = 1) {
  return [
    { type: "message_start", message: { id: "msg", type: "message", role: "assistant", content: [], model: "scripted-model", usage: { input_tokens: inputTokens, output_tokens: 0 } } },
    ...blocks.flatMap((block, index) => [
      { type: "content_block_start", index, content_block: block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" } },
      block.type === "text" ? { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } }
        : { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } },
      { type: "content_block_stop", index },
    ]),
    { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
}
const frame = (event: { type: string }) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
function sse(blocks: Block[], stop: string, inputTokens = 1): Response {
  return new Response(sseEvents(blocks, stop, inputTokens).map(frame).join(""), { headers: { "content-type": "text/event-stream" } });
}

/** The response's first text block, half streamed; `lost` runs once its Delta has left, and the stream never ends. */
function lostMidStream(blocks: Block[], streamed: () => boolean, lost: () => void): Response {
  const first = blocks[0];
  if (first?.type !== "text") throw new Error("A response lost mid-stream starts with text");
  const half = first.text.slice(0, Math.ceil(first.text.length / 2));
  const events = [sseEvents(blocks, "end_turn")[0], { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: half } }];
  return new Response(new ReadableStream({
    async start(controller) {
      for (const event of events) controller.enqueue(new TextEncoder().encode(frame(event)));
      while (!streamed()) await new Promise((resolve) => setTimeout(resolve, 2));
      lost();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

function request(body: { model: string; thinking?: unknown; system?: unknown; messages: Array<{ role: string; content: unknown }> }, runner: number, index: number): ModelRequest {
  const results = new Map<string, { isError: boolean; text: string }>();
  let lastUser = "";
  for (const message of body.messages) {
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }]
      : message.content as Array<{ type: string; text?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }>;
    for (const block of blocks) {
      if (block.type === "tool_result" && block.tool_use_id) results.set(block.tool_use_id, { isError: block.is_error === true, text: JSON.stringify(block.content) });
      else if (message.role === "user" && block.type === "text" && block.text) lastUser = block.text;
    }
  }
  const system = JSON.stringify(body.system ?? "");
  return { index, summary: system.includes("You are a context summarization assistant"), lastUser,
    text: JSON.stringify(body.messages), results, runner, model: body.model, thinking: body.thinking, system };
}

/** A Sandbox that speaks the Pi tool wrapper's protocol in process, with `tool` as every tool. */
function sandbox(runner: Runner, run: (call: Omit<ToolCall, "runner">) => Promise<string>, sent: (command: string[]) => void, disposed: () => void): SandboxManager {
  const files = new Map<string, Uint8Array>();
  let temporary = 0;
  const missing = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  const unsupported = async () => { throw new Error("not used by the scenario's tools"); };
  // Own properties: the fenced executor guards each one by its key.
  const fileSystem: ToolFileSystem = {
    readFile: async (path) => { const content = files.get(path); if (!content) throw missing(path); return content; },
    writeFile: async (path, content) => { files.set(path, content); },
    createTempFile: async () => { const path = `/home/user/workspace/.tmp/request-${++temporary}.json`; files.set(path, new Uint8Array()); return path; },
    access: unsupported, stat: unsupported, lstat: unsupported, realpath: unsupported, readdir: unsupported, mkdir: unsupported, appendFile: unsupported,
  };
  const session: SandboxSession = {
    fileSystem,
    async *exec(command: string[], options?: ExecOptions) {
      if (runner.dead) await GONE;
      sent(command);
      // Only the tool wrapper runs a scenario tool; cleanup commands just exit.
      if (command[1] === "--input-type=module") {
        const sent = JSON.parse(Buffer.from(files.get(command.at(-1)!) ?? new Uint8Array()).toString()) as { id: string; name: string; args: Json };
        // The wrapper reports its pid as it starts, so Pi can ask it to abort (#240).
        yield { stream: "stdout" as const, text: JSON.stringify({ type: "accepted", pid: 4242 }) + "\n" };
        const text = await run({ id: sent.id, name: sent.name, args: sent.args });
        // A command that outlives its Runner reports to nobody.
        if (runner.dead) await GONE;
        yield { stream: "stdout" as const, text: JSON.stringify({ type: "result", result: { content: [{ type: "text", text }], details: undefined } }) + "\n" };
      }
      options?.onExit?.({ exitCode: 0 });
    },
    readFile: unsupported, writeFile: unsupported, list: unsupported,
    prepare: async () => {}, checkWorkspace: async () => {}, dispose: async () => { disposed(); },
  };
  return { open: () => session, list: async () => [], reclaim: async () => {} };
}

export const PROVIDER = "scripted";
/** The scripted provider's models: every scenario's Agent starts with the first. */
export const MODELS = ["scripted-model", "scripted-model-next"] as const;

/** Pi settings every scenario runs with: compaction on small windows only, and fast retries. */
export async function piAgentDir(): Promise<{ dir: string; remove(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "oma-crash-injection-"));
  await writeFile(join(dir, "settings.json"), JSON.stringify({
    compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 30 },
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
  }));
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * Execute `scenario`, losing Runner i right after its `loseAfter[i]`th
 * durable write, or the first one `loseAfter[i]` picks (never, when
 * undefined), or shutting it down right after its `shutDownAfter[i]`th, until
 * the Runners drain every Session.
 */
export async function execute(scenario: Scenario, loseAfter: Array<LoseAfter | undefined> = [],
  shutDownAfter: Array<number | undefined> = []): Promise<Outcome> {
  const stores = createMemoryStores();
  const agent = await stores.agentStore.create({ tenantId: "tenant", name: "Pi", model: `${PROVIDER}/${MODELS[0]}`, system: "",
    runtime: "pi-agent", sandbox: { enabled: true } });
  const workspace = await stores.workspaceStore.create({ tenantId: "tenant" });
  const session = await stores.sessionStore.create({ tenantId: "tenant", agentId: agent.id, agent, workspaceId: workspace.id });
  const enqueue = (text: string) => stores.pendingEventStore.enqueue(session.id,
    { type: "user.message", data: { content: [{ type: "text", text }] }, sessionThreadId: "sthr_primary" });
  for (const text of scenario.inputs) await enqueue(text);
  /** The scripted provider as a Runner's Pi sees it. */
  const providerOf = (runner: number): CustomProviderDefinition => ({ id: PROVIDER, name: "Scripted", api: "anthropic-messages",
    baseUrl: "https://model.example.invalid", apiKey: "controlled-test-key",
    models: (scenario.models?.(runner) ?? MODELS).map((id) => ({ id, name: id, contextWindow: scenario.contextWindow ?? 200_000, maxTokens: 8192, input: ["text"] })) });
  const outcome: Outcome = { log: [], sessionId: session.id, sessions: [], executions: [], stores, runners: [], requests: [], toolCalls: [], attempts: [], losses: [], commands: [], errors: [], deltas: [], disposals: [] };
  // The Redis stand-in all Runners share; it records every Delta as it is appended.
  const turnStreams = new InMemoryTurnStreamStore();
  const appendDelta = turnStreams.appendDelta.bind(turnStreams);
  turnStreams.appendDelta = async (sessionId, delta) => { outcome.deltas.push(delta); return appendDelta(sessionId, delta); };
  // Redis as a Runner reaches it while it is down: production wraps it as best effort.
  const redisDown = new BestEffortTurnStreamStore(new Proxy({} as TurnStreamStore, {
    get: () => () => Promise.reject(new Error("Redis connection is closed")) }), () => true);
  const readLog = async (sessionId = session.id) => (await stores.eventLogStore.getEvents(sessionId, { limit: 100_000 })).data;
  const executions = async () => (await stores.delegationStore.listExecutions("tenant", { callerSessionId: session.id, limit: 500 })).reverse();
  /** The messages a Run sent the scenario's Session after it started. */
  const sent: string[] = [];
  /**
   * A Session's inputs: the scenario's, then those sent, then each Delegation
   * Result a Turn of its own delivered; or the prompt of each execution of a
   * Child Session.
   */
  const inputsOf = async (sessionId: string) => sessionId === session.id
    ? [...scenario.inputs, ...sent, ...(await readLog()).filter((event) => event.type === "subagent.result_claimed").map((event) => inputKey(event.type, event.data)!)]
    : (await stores.delegationStore.listExecutions("tenant", { childId: sessionId, limit: 500 }))
      .sort((a, b) => a.sequence - b.sequence).map((execution) => execution.prompt);
  /** The input each loss held, by key: a Delegation Result is promoted only by the claim that runs it. */
  const lostInputs = new Map<Loss, string>();
  const sessionIds = async () => [session.id, ...new Set((await executions()).map((execution) => execution.childId))];

  // A lost Runner's claim lapses: the next claim takes the input over. An
  // Interrupt the API accepted under it right before is the next claim's to apply.
  const lapse = (runner: Runner) => {
    const state = stores.pendingEventStore.snapshotState();
    for (const claim of state.claims.values()) {
      if (claim.ownerId !== runner.ownerId) continue;
      if (scenario.interruptOnLoss) claim.interruptGeneration = claim.generation;
      claim.expiresAtMs = 0;
    }
    stores.pendingEventStore.restoreState(state);
  };
  const apart = scenario.children === "apart";
  interface Host { runner: Runner; router: SessionRouter; run: Run; role: Role }
  /** The Runner of each role; a lost one stays until its replacement takes its place. */
  const hosts = new Map<Role, Host>();
  const live = () => [...hosts.values()].filter((host) => !host.runner.dead);
  // A wake goes to the Runner of the Session's role, a check hint to every
  // Runner; one sent to a lost Runner is lost with it.
  const checkSession = (sessionId: string) => { for (const host of live()) host.router.checkNow(sessionId); };
  const wakeSession = (sessionId: string) => {
    void stores.sessionStore.getById(sessionId).then((target) => {
      const host = hosts.get(target?.delegation ? "child" : "parent");
      if (!target || target.status === "terminated" || !host || host.runner.dead) return;
      return host.router.handleNewEvent(sessionId, target.agent).catch((error) => { outcome.errors.push({ runner: host.runner.index, error }); });
    });
  };
  const startRunner = (index: number, role: Role): Host => {
    const runner: Runner = new Runner(index, loseAfter[index], lapse, (store, method, args) =>
      store === "eventLogStore" && method === "append" && scenario.refuse?.(args[1] as { type: string; data: unknown }, run) === true,
      shutDownAfter[index]);
    let router!: SessionRouter;
    const run: Run = { crash: () => runner.lose(), lose: (lost) => hosts.get(lost)?.runner.lose(), runner: index, log: readLog,
      // The process exits once its Router has handed its Turns over.
      shutDown: (graceMs = 20_000) => { runner.handingOff ??= router.handOff(graceMs).then((handedOver) => { runner.exit(); return handedOver; }); },
      requestInterrupt: (sessionId = session.id) => stores.pendingEventStore.requestInterrupt(sessionId),
      interrupt: async (sessionId) => {
        const requested = await stores.pendingEventStore.requestInterrupt(sessionId);
        if (requested) checkSession(sessionId);
        return requested;
      },
      // The API wakes every Runner for new input; the one that executes the Session joins its drain.
      send: async (text) => {
        sent.push(text);
        await enqueue(text);
        for (const host of live()) if (host.role === "parent") void host.router.handleNewEvent(session.id, agent).catch((error) => { outcome.errors.push({ runner: host.runner.index, error }); });
      },
      terminate: async () => {
        await stores.sessionStore.terminate(session.id);
        await stores.pendingEventStore.clear(session.id);
      },
      executions, stores, agentId: agent.id, sessionId: session.id };
    const fetchModel: typeof fetch = async (_url, init) => {
      if (runner.dead) return GONE;
      const sent = request(JSON.parse(String(init?.body)), index, outcome.requests.length);
      outcome.requests.push(sent);
      const reply = await scenario.model(sent, run);
      if (runner.dead) return GONE;
      if ("error" in reply) {
        return new Response(JSON.stringify({ type: "error", error: { type: reply.error.type, message: reply.error.message } }),
          { status: reply.error.status, headers: { "content-type": "application/json" } });
      }
      if (reply.lostMidStream) {
        const before = outcome.deltas.length;
        return lostMidStream(reply.blocks, () => outcome.deltas.slice(before).some((delta) => delta.type === "agent.message_chunk"), () => runner.lose());
      }
      return sse(reply.blocks, reply.stop, reply.inputTokens);
    };
    const provider = providerOf(index);
    const pi = new PiAgentAdapter({ configureModelRuntime: (_input, runtime) => registerCustomProvider(runtime, provider, fetchModel) });
    const adapter: Adapter = { async run(input) {
      if (runner.dead) return GONE;
      outcome.attempts.push({ runner: index, input, log: await readLog(input.sessionId) });
      return pi.run(input);
    } };
    const turnStreamStore = scenario.redisDown?.(index) ? redisDown : turnStreams;
    router = new SessionRouter({ ...runner.stores({ ...stores, turnStreamStore }), eventStreamHub: new InProcessEventStreamHub(), resolveAdapter: () => adapter,
      sandboxManager: sandbox(runner, async (call) => {
        const toolCall = { ...call, runner: index };
        outcome.toolCalls.push(toolCall);
        return scenario.tool ? scenario.tool(toolCall, run) : `ran ${call.id}`;
      }, (command) => outcome.commands.push({ runner: index, command }), () => outcome.disposals.push(index)),
      workspaceMount: { bucket: "agentry", agentName: "agentry-workspace", pvName: "agentry-workspace-oss", credentialProviderName: "agentry-oss-rw" },
      pendingClaimOwnerId: runner.ownerId, onDrainError: ({ error }) => outcome.errors.push({ runner: index, error }),
      ...(scenario.childSteps !== undefined ? { maxSubagentModelSteps: scenario.childSteps } : {}),
      ...(scenario.maxChildren !== undefined ? { maxConcurrentSubagents: scenario.maxChildren } : {}),
      ...(apart ? { wakeSession, checkSession } : {}) });
    runner.shutDown = () => run.shutDown();
    outcome.runners.push(runner);
    const host = { runner, router, run, role };
    hosts.set(role, host);
    return host;
  };
  /** A Runner's own call, which never returns once the Runner is lost. */
  const unlessLost = (host: Host, work: Promise<unknown>) => Promise.race([work, host.runner.died]);
  const drained = async () => {
    for (const id of await sessionIds()) if (await stores.pendingEventStore.count(id) > 0) return false;
    return true;
  };

  // The first Runner is woken by the input's arrival; each later one finds
  // the input its predecessor left in its pending scan.
  const first = startRunner(0, "parent");
  if (apart) startRunner(1, "child");
  void first.router.handleNewEvent(session.id, agent);
  for (let scans = 0; ;) {
    const lost = [...hosts.values()].find((host) => host.runner.dead);
    if (!lost) {
      const current = live();
      const settled = await Promise.race([...current.map((host) => host.runner.died.then(() => "lost" as const)),
        Promise.all(current.map((host) => host.router.waitForIdle(30_000))).then((idle) => idle.every(Boolean) ? "idle" as const : "stuck" as const)]);
      if (settled === "stuck") throw new Error(`Runners ${current.map((host) => host.runner.index).join(", ")} neither drained the Session nor were lost`);
      if (settled === "lost") continue;
      // A Runner shut down went idle as it handed its Turns over; its process exits once the handoff is done.
      const handingOff = current.filter((host) => host.runner.handingOff);
      if (handingOff.length) { await Promise.all(handingOff.map((host) => host.runner.handingOff)); continue; }
      if (await drained()) {
        await cleanUpTerminated(current);
        break;
      }
      // A refused write stops the attempt (ADR-0020). The Runner stays up, and
      // the claim it no longer renews lapses after its lease.
      const refused = current.find((host) => outcome.errors.some((error) => error.runner === host.runner.index && error.error instanceof RefusedWrite));
      if (refused) { refused.runner.lose(); continue; }
      // Only a wake sent to a lost Runner leaves input no live Runner drains;
      // the pending scan finds it.
      if (!apart) throw new Error(`Runner ${current[0].runner.index} went idle and left input queued`);
      if (++scans > 100) throw new Error("The Sessions' input was not drained");
      await new Promise((resolve) => setTimeout(resolve, 5));
      for (const host of live()) await unlessLost(host, host.router.recoverPendingEvents());
      continue;
    }
    if (outcome.runners.length > 12) throw new Error("The Session was not drained after 12 Runners");
    outcome.losses.push(...await lossesOf(lost.runner));
    await scenario.afterLoss?.(lost.run);
    const replacement = startRunner(outcome.runners.length, lost.role);
    await unlessLost(replacement, replacement.router.recoverPendingEvents());
  }
  outcome.executions = await executions();
  for (const [loss, key] of lostInputs) loss.input = (await inputsOf(loss.sessionId!)).indexOf(key);
  outcome.sessions = await Promise.all((await sessionIds()).map(async (id) => ({ id, inputs: await inputsOf(id), log: await readLog(id) })));
  outcome.log = outcome.sessions[0].log;
  return outcome;

  /**
   * A Runner's cleanup sweep releases what a terminated Session left, its
   * Sandbox included, once no Runner still executes it.
   */
  async function cleanUpTerminated(current: Host[]): Promise<void> {
    const [sweeper] = current;
    if (!sweeper) return;
    for (const id of await sessionIds()) {
      if ((await stores.sessionStore.getById(id))?.status !== "terminated") continue;
      for (let sweeps = 0; !await sweeper.router.cleanupTerminatedSession(id); sweeps++) {
        if (sweeps > 100) throw new Error(`Session ${id} was never cleaned up`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  }

  /**
   * The inputs a lost Runner held, or a Runner shut down handed over, and
   * their Turns' calls that had no result then.
   */
  async function lossesOf(runner: Runner): Promise<Loss[]> {
    const held = new Map<string, PendingEventClaim>();
    const released = new Map<string, PendingEventClaim>();
    for (const write of runner.writes) {
      const sessionId = write.args[0] as string;
      if (write.method === "claim") { held.set(sessionId, write.result as PendingEventClaim); released.delete(sessionId); }
      else if (write.method === "ackCompletedTurn" && (write.result as { acknowledged: boolean }).acknowledged) held.delete(sessionId);
      else if (write.method === "releaseClaim" && write.result === true) {
        const claim = held.get(sessionId);
        if (claim) released.set(sessionId, claim);
        held.delete(sessionId);
      }
    }
    // A lost Runner's claims lapse; one shut down ends holding none, and the inputs it released are the ones it handed over.
    const reason: PendingEventClaimEnd = runner.handingOff ? "released" : "expired";
    const left = runner.handingOff ? released : held;
    const detached = runner.handingOff ? { detached: !await runner.handingOff } : {};
    if (!left.size) return [{ runner: runner.index, reason, dangling: [], ...detached }];
    const losses: Loss[] = [];
    for (const [sessionId, claim] of left) {
      const key = inputKey(claim.event.type, claim.event.data)!;
      const events = eventsOfKey(await readLog(sessionId), key);
      const loss: Loss = { runner: runner.index, reason, sessionId, input: (await inputsOf(sessionId)).indexOf(key), generation: claim.generation,
        completed: events.some((event) => event.type === "session.turn_completed"), dangling: dangling(events), ...detached };
      lostInputs.set(loss, key);
      losses.push(loss);
    }
    return losses;
  }
}

/** The input's promotion and every event after it, up to the next input's promotion. */
export function eventsOfInput(log: StoredEvent[], session: Pick<Scenario, "inputs">, input: number): StoredEvent[] {
  return eventsOfKey(log, session.inputs[input]);
}

/**
 * How the harness names an input: a user message or a Child Session's
 * Delegation Input by its text, a Delegation Result by the execution it reports.
 */
function inputKey(type: string, data: unknown): string | undefined {
  if (type === "subagent.result" || type === "subagent.result_claimed") return `subagent.result:${(data as { executionId: string }).executionId}`;
  return ((data as { content?: Array<{ text?: string }> } | null)?.content ?? [])[0]?.text;
}

const PROMOTIONS = new Set(["user.message", "delegation.input", "subagent.result_claimed"]);
function eventsOfKey(log: StoredEvent[], key: string | undefined): StoredEvent[] {
  const promotions = log.filter((event) => PROMOTIONS.has(event.type));
  const start = promotions.find((event) => inputKey(event.type, event.data) === key);
  if (!start) return [];
  const next = promotions.find((event) => event.seq > start.seq);
  return log.filter((event) => event.seq >= start.seq && (!next || event.seq < next.seq));
}
const turnIdOf = (event: StoredEvent) => (event.data as { turnId?: unknown } | null)?.turnId;
const displayed = (log: StoredEvent[]) => log.flatMap((event) => presentEvent(event));

/** Tool calls without a result, in call order. */
export function dangling(log: StoredEvent[]): string[] {
  const shown = displayed(log);
  const answered = new Set(shown.filter((event) => event.type === "agent.tool_result" || event.type === "agent.mcp_tool_result")
    .map((event) => (event.data as { toolUseId: string }).toolUseId));
  return [...new Set(shown.filter((event) => event.type === "agent.tool_use" || event.type === "agent.mcp_tool_use")
    .map((event) => (event.data as { toolUseId: string }).toolUseId).filter((id) => !answered.has(id)))];
}

const isUser = (event: StoredEvent) => event.type === "agent.context_entry" &&
  (event.data as { entry?: { message?: { role?: string } } }).entry?.message?.role === "user";
const isAssistant = (event: StoredEvent) => event.type === "agent.context_entry" &&
  (event.data as { entry?: { message?: { role?: string } } }).entry?.message?.role === "assistant";

/** How the result of a call an Interrupt stopped before its result was committed begins (#249). */
export const INTERRUPTED_PREFIX = "The previous tool execution was interrupted before a result was committed";
/** Tools the Host runs itself, not the Sandbox: the delegation records say what their calls did. */
const HOST_TOOLS = new Set(["Agent", "get_subagent_result", "steer_subagent"]);

export interface Expected {
  /**
   * Calls of the scenario's Session a lost Runner left dangling that the
   * takeover answers from the delegation record they left (#251), instead of
   * as of unknown outcome. Inferred from the results when not given.
   */
  recorded?: string[];
}

/**
 * The assertions every resumed scenario meets (RECOVERY-MATRIX.md), in every
 * Session it runs: each input completes once, in its original Turn and in
 * order, with no recovery error; every call has exactly one result and only
 * calls left dangling by a lost Runner report an unknown outcome; no tool
 * runs twice; model steps continue from the log; each takeover is marked
 * once, with why it happened and the calls it found dangling; and no lost
 * Runner writes after it is lost.
 */
export function expectResumed(scenario: Scenario, outcome: Outcome, expected: Expected = {}): void {
  const written = rowsWritten(outcome);
  for (const session of outcome.sessions) {
    expectSessionResumed(scenario, outcome, session, written, session.id === outcome.sessionId ? expected.recorded : undefined);
  }
  // No tool runs twice.
  const executions = outcome.toolCalls.map((call) => call.id);
  expect(executions).toEqual([...new Set(executions)]);
  // Model steps continue from the log: an attempt continues exactly when its
  // input is in the Turn's native history, from the steps the log counts.
  for (const attempt of outcome.attempts) {
    const turn = attempt.log.filter((event) => turnIdOf(event) === attempt.input.turnId);
    const steps = turn.filter((event) => event.type === "span.model_request_start").length;
    expect(attempt.input.resume !== undefined, `attempt of runner ${attempt.runner} continues`).toBe(turn.some(isUser));
    expect(attempt.input.resume?.completedModelSteps ?? 0, `steps of runner ${attempt.runner}`).toBe(steps);
  }
  // No double billing: no more usage is recorded than the model was asked
  // for, and every step but one a loss cut short ended. A step an Interrupt
  // or the budget stops before its request ends without usage.
  const logs = outcome.sessions.flatMap((session) => session.log);
  const ends = logs.filter((event) => event.type === "span.model_request_end");
  const billed = ends.filter((event) => Object.values((event.data as { usage?: Record<string, unknown> }).usage ?? {})
    .some((tokens) => typeof tokens === "number" && tokens > 0));
  expect(billed.length).toBeLessThanOrEqual(outcome.requests.filter((sent) => !sent.summary).length);
  expect(logs.filter((event) => event.type === "span.model_request_start").length).toBeLessThanOrEqual(ends.length + outcome.losses.length);
  // No Runner reports a failure but a write the scenario refused: a lost one
  // is gone before it could, and the one that takes over never loses its
  // claim or a write.
  expect(outcome.errors.filter(({ error }) => !(error instanceof RefusedWrite))).toEqual([]);
}

function expectSessionResumed(scenario: Scenario, outcome: Outcome, session: SessionOutcome, written: Set<string>, recorded?: string[]): void {
  const { log } = session;
  const of = session.id === outcome.sessionId ? "" : `child ${session.id}: `;
  // Each input completes exactly once, in the Turn its first attempt named, in order.
  const completions = log.filter((event) => event.type === "session.turn_completed");
  expect(completions, `${of}completions`).toHaveLength(session.inputs.length);
  session.inputs.forEach((_text, input) => {
    const events = eventsOfInput(log, session, input).filter((event) => event.type !== "subagent.result");
    const named = [...new Set(events.map(turnIdOf).filter((turnId) => turnId !== undefined))];
    expect(named, `${of}input ${input} is one Turn`).toHaveLength(1);
    expect(events.filter((event) => event.type === "session.turn_completed").map(turnIdOf)).toEqual(named);
    expect(events.at(-1)?.type === "session.turn_completed" || events.at(-1)?.type === "session.status_idle").toBe(true);
  });
  // No error but the scenario's own: a recovery error only where it expects one (the takeover limit).
  const errorCodes = log.filter((event) => event.type === "session.error").map((event) => (event.data as { error: { code: string } }).error.code);
  expect(errorCodes.filter((code) => !(scenario.errors ?? []).includes(code)), `${of}errors`).toEqual([]);
  // Every call has exactly one result.
  const shown = displayed(log);
  const results = shown.filter((event) => event.type === "agent.tool_result" || event.type === "agent.mcp_tool_result");
  const resultOf = (call: string) => results.filter((event) => (event.data as { toolUseId: string }).toolUseId === call);
  const uses = shown.filter((event) => event.type === "agent.tool_use" || event.type === "agent.mcp_tool_use");
  const calls = [...new Set(uses.map((event) => (event.data as { toolUseId: string }).toolUseId))];
  const nameOf = (call: string) => (uses.find((event) => (event.data as { toolUseId: string }).toolUseId === call)?.data as { name?: string }).name;
  for (const call of calls) expect(resultOf(call), `${of}results of ${call}`).toHaveLength(1);
  // "Outcome unknown" exactly for the calls a lost Runner left without a
  // result, but those whose delegation record answers them (#251) and those
  // an Interrupt the takeover applied stopped.
  const says = (prefix: string) => results.filter((event) => JSON.stringify(event.data).includes(prefix))
    .map((event) => (event.data as { toolUseId: string }).toolUseId);
  const unknown = says(OUTCOME_UNKNOWN_PREFIX);
  const interrupted = says(INTERRUPTED_PREFIX);
  const left = [...new Set(outcome.losses.filter((loss) => loss.sessionId === session.id).flatMap((loss) => loss.dangling))];
  const fromRecord = left.filter((call) => HOST_TOOLS.has(nameOf(call) ?? "") && !unknown.includes(call) &&
    JSON.stringify(resultOf(call)[0]?.data).includes("executionId"));
  if (recorded) expect(new Set(fromRecord), `${of}calls answered from their record`).toEqual(new Set(recorded));
  expect(new Set(unknown), `${of}calls of unknown outcome`).toEqual(new Set(left.filter((call) => !fromRecord.includes(call) && !interrupted.includes(call))));
  // A handoff leaves a call without a result only when its deadline detached the Turn.
  for (const loss of outcome.losses) if (loss.sessionId === session.id && loss.reason === "released" && !loss.detached) expect(loss.dangling).toEqual([]);
  // A Sandbox call with a real result ran.
  const executions = outcome.toolCalls.map((call) => call.id);
  for (const call of calls.filter((id) => !unknown.includes(id) && !interrupted.includes(id) && !HOST_TOOLS.has(nameOf(id) ?? ""))) {
    expect(executions, `${of}${call} ran`).toContain(call);
  }
  // Each model step and its usage is recorded once; every committed answer counts.
  const starts = log.filter((event) => event.type === "span.model_request_start");
  for (const spans of [starts, log.filter((event) => event.type === "span.model_request_end")]) {
    const ids = spans.map((event) => (event.data as { id: string }).id);
    expect(ids).toEqual([...new Set(ids)]);
  }
  expect(starts.length).toBeGreaterThanOrEqual(log.filter(isAssistant).length);
  // One marker per takeover, with the reason and the calls it found dangling.
  // A claim its owner released (a Child execution that waited for a slot)
  // is taken over without a loss.
  const markers = log.filter((event) => event.type === "session.turn_resumed");
  const markersOf = (input: number, generation: (marked: number) => boolean) => eventsOfInput(log, session, input)
    .filter((event) => event.type === "session.turn_resumed" && generation((event.data as { generation: number }).generation));
  for (const marker of markers) expect(Object.keys(marker.data as object).sort()).toEqual(["danglingToolUseIds", "generation", "reason", "turnId"]);
  const takeovers = outcome.losses.filter((loss) => loss.sessionId === session.id && loss.input !== undefined);
  for (const loss of takeovers) {
    const found = markersOf(loss.input!, (generation) => generation === loss.generation! + 1);
    expect(found.length, `${of}markers of generation ${loss.generation! + 1}`).toBeLessThanOrEqual(1);
    for (const marker of found) expect(marker.data).toMatchObject({ reason: loss.reason, danglingToolUseIds: loss.dangling });
  }
  // The takeover that drained the input marked itself, unless it only
  // acknowledged a completed Turn.
  const last = takeovers.at(-1);
  if (last) expect(markersOf(last.input!, (generation) => generation > last.generation!), `${of}markers after the last loss`).toHaveLength(last.completed ? 0 : 1);
  const expired = (reasons: Array<{ reason: string }>) => reasons.filter(({ reason }) => reason === "expired").length;
  expect(expired(markers.map((marker) => marker.data as { reason: string }))).toBeLessThanOrEqual(expired(takeovers));
  // Every row came from a write a live Runner made, or the idle its acknowledgement committed.
  expect(log.filter((event) => !written.has(`${session.id}:${event.seq}`)).map((event) => event.type), `${of}rows no live Runner wrote`).toEqual([]);
}

/** Every row a Runner's durable writes committed, as `sessionId:seq`. */
function rowsWritten(outcome: Outcome): Set<string> {
  const rows = new Set<string>();
  const add = (sessionId: unknown, seq: unknown) => { if (typeof sessionId === "string" && typeof seq === "number") rows.add(`${sessionId}:${seq}`); };
  for (const write of outcome.runners.flatMap((runner) => runner.writes)) {
    const result = write.result as Record<string, unknown>;
    if (write.method === "append") add(write.args[0], result.seq);
    else if (write.method === "ackCompletedTurn") add(write.args[0], (result.idleEvent as StoredEvent | undefined)?.seq);
    // Delegation transactions append to the logs they coordinate.
    else if (write.method === "consumeResult") add((write.args[1] as { callerSessionId: string }).callerSessionId, result.seq);
    else if (write.method === "applyCommand") add(result.childId, (result as unknown as DelegationCommand).appliedEventSeq);
    else if (write.method === "finishExecution") add(result.callerSessionId, (result as unknown as DelegationExecution).notificationEventSeq);
    else if (write.method === "command" && result.status === "applied") {
      // Withdrawing a queued execution ends it, which notifies its parent.
      const execution = outcome.executions.find((candidate) => candidate.id === result.executionId);
      add(execution?.callerSessionId, execution?.notificationEventSeq);
    }
  }
  return rows;
}

/**
 * Lose a Runner (the first, unless `runner` names another) after each
 * durable write it makes, one execution per write, and check every execution
 * resumes. The writes are those of an execution that loses no Runner, which
 * must itself pass.
 */
export async function sweep(scenario: Scenario, also: (outcome: Outcome, write: number) => void | Promise<void> = () => {},
  { runner = 0 }: { runner?: number } = {}): Promise<void> {
  const writes = await writesOf(scenario, runner);
  it("has a durable write to lose the Runner after", () => expect(writes.length).toBeGreaterThan(0));
  it.each(writes.map((write, index) => [rowOf(writes, index), runner, index + 1, describeWrite(write)] as const))("%s Runner %i lost after write %i (%s): the Turn resumes and completes", async (_row, _runner, n) => {
    const loseAfter: LoseAfter[] = [];
    loseAfter[runner] = n;
    const outcome = await execute(scenario, loseAfter);
    expectResumed(scenario, outcome);
    await also(outcome, n);
  });
}

/**
 * Shut the first Runner down right after each durable write the scenario
 * makes (#254), one execution per write, and check every execution hands the
 * Turn over cleanly: its tools finish within the grace period, so no call's
 * outcome is unknown.
 */
export async function handoffSweep(scenario: Scenario, also: (outcome: Outcome, write: number) => void | Promise<void> = () => {}): Promise<void> {
  const writes = await writesOf(scenario);
  it.each(writes.map((write, index) => [`F@${rowOf(writes, index)}`, index + 1, describeWrite(write)] as const))("%s Runner shut down after write %i (%s): the Turn is handed over and completes", async (_row, n) => {
    const outcome = await execute(scenario, [], [n]);
    expectResumed(scenario, outcome);
    expect(outcome.losses).toEqual([expect.objectContaining({ runner: 0, reason: "released", detached: false, dangling: [] })]);
    // Whatever the takeover found, it was handed over, never lost.
    expect(outcome.log.filter((event) => event.type === "session.turn_resumed").map((event) => (event.data as { reason: string }).reason)
      .filter((reason) => reason !== "released")).toEqual([]);
    await also(outcome, n);
  });
}

/** Run a test file's scenarios with Pi settings of their own. */
export async function usePiSettings(): Promise<void> {
  const agentDir = await piAgentDir();
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir.dir);
  afterAll(async () => { vi.unstubAllEnvs(); await agentDir.remove(); });
}

/** A Runner's durable writes when no Runner is lost: the crash points of a sweep. */
export async function writesOf(scenario: Scenario, runner = 0): Promise<Write[]> {
  const outcome = await execute(scenario);
  expectResumed(scenario, outcome);
  return outcome.runners[runner].writes;
}

/** A label for a write, for test names: `append agent.context_entry(user)`. */
export function describeWrite(write: Write): string {
  if (write.method !== "append") return write.method;
  const stored = write.result as StoredEvent;
  const entry = (stored.data as { entry?: { type?: string; message?: { role?: string } } }).entry;
  return `append ${stored.type}${entry ? `(${entry.message?.role ?? entry.type})` : ""}`;
}

/**
 * The RECOVERY-MATRIX.md row a loss right after `writes[index]` exercises:
 * what the log's last durable fact is then.
 */
export function rowOf(writes: Write[], index: number): string {
  const write = writes[index];
  if (write.method === "claim") return "A1";
  if (write.method === "updateStatusIfClaimed") return "A2";
  if (write.method === "ackCompletedTurn") return "A14";
  // The delegation facts of matrix section C.
  const delegation = write.result as { mode?: string; kind?: string };
  if (write.method === "accept") return delegation.mode === "sync" ? "C1" : "C4";
  if (write.method === "saveWait") return "C5";
  if (write.method === "startExecution") return "C7";
  if (write.method === "finishExecution" || write.method === "consumeResult") return "C2";
  if (write.method === "command" || write.method === "applyCommand") return delegation.kind === "steer" ? "C9" : "C12";
  if (write.method !== "append") return write.method;
  const stored = write.result as StoredEvent;
  const data = stored.data as { entry?: { type?: string; message?: { role?: string; content?: Array<{ type: string }>; stopReason?: string } } };
  // The facts of the same Session's input so far.
  const before = writes.slice(0, index).filter((earlier) => earlier.method === "append" && earlier.args[0] === write.args[0])
    .map((earlier) => earlier.result as StoredEvent);
  const types = before.map((earlier) => earlier?.type);
  const sinceInput = before.slice(Math.max(types.lastIndexOf("user.message"), types.lastIndexOf("delegation.input")) + 1);
  if (stored.type === "user.message" || stored.type === "delegation.input") return "A2";
  if (stored.type === "session.status_running") return "A3";
  if (stored.type === "session.turn_completed") return "A13";
  if (stored.type === "session.error") return "A12";
  // A summary request in flight, then its committed outcome.
  if (stored.type === "agent.compaction") return (stored.data as { status?: string }).status === "started" ? "B1" : "B2";
  const message = data.entry?.message;
  if (data.entry?.type === "compaction") return "B2";
  if (!sinceInput.some((earlier) => earlier?.type === "agent.context_entry" &&
    (earlier.data as { entry?: { message?: { role?: string } } }).entry?.message?.role === "user") && message?.role !== "user") return "A4";
  if (message?.role === "user") return "A5";
  if (message?.role === "assistant") {
    if (message.stopReason === "error" || message.stopReason === "aborted") return "A11";
    return message.content?.some((block) => block.type === "toolCall") ? "A6" : "A10";
  }
  if (message?.role === "toolResult") return writes[index + 1] && (writes[index + 1].result as StoredEvent)?.type === "agent.context_entry" &&
    ((writes[index + 1].result as StoredEvent).data as { entry?: { message?: { role?: string } } }).entry?.message?.role === "toolResult" ? "A8" : "A9";
  return "A19";
}

export const text = (value: string): Block => ({ type: "text", text: value });
export const bash = (id: string, command: string): Block => ({ type: "tool_use", id, name: "bash", input: { command } });
