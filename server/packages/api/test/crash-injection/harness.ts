import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { createMemoryStores, type MemoryStores } from "@oma-server/store-memory";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { InMemoryTurnStreamStore, type TurnDelta } from "@oma-server/redis";
import type { SandboxManager, SandboxSession } from "@oma-server/sandbox";
import { SessionRouter } from "@oma-server/session-router";
import { presentEvent, type DelegationExecution, type PendingEventClaimEnd, type StoredEvent } from "@oma-server/store";
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
}

/** What one execution of a scenario produced, for assertions. */
export interface Outcome {
  log: StoredEvent[];
  sessionId: string;
  /** The stores every Runner shared, as the last one left them. */
  stores: MemoryStores;
  runners: Runner[];
  requests: ModelRequest[];
  toolCalls: ToolCall[];
  /** Each Adapter run, with the log as it was when the run started. */
  attempts: Array<{ runner: number; input: AdapterInput; log: StoredEvent[] }>;
  /**
   * What each Runner left as it stopped executing the Session, lost or shut
   * down: the input it held or handed over and the calls without a result.
   */
  losses: Loss[];
  /** Every command a Runner sent the Sandbox, in order. */
  commands: Array<{ runner: number; command: string[] }>;
  errors: Array<{ runner: number; error: unknown }>;
  /** Every Delta any Runner streamed, in order. */
  deltas: TurnDelta[];
}

export interface Loss {
  runner: number;
  /**
   * How its claim ended: it lapsed (`expired`), as a lost Runner's does and a
   * Runner's stopped by a failed write, or the Runner handed the Turn over
   * (`released`).
   */
  reason: PendingEventClaimEnd;
  /** The input whose claim the Runner held, by its position in Scenario.inputs; undefined when it held none. */
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
  /** Accept an Interrupt for the Session's running Turn, as the API does. */
  requestInterrupt(): Promise<boolean>;
  /** The Session's durable log as it is now. */
  log(): Promise<StoredEvent[]>;
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

/** Durable writes, by store and method. A claim that finds no head writes nothing. */
const WRITES: Record<string, readonly string[]> = {
  eventLogStore: ["append"],
  pendingEventStore: ["claim", "releaseClaim", "ackCompletedTurn"],
  sessionStore: ["updateStatusIfClaimed"],
  // The coordination records of a delegation scenario's Turns.
  delegationStore: ["accept", "saveWait", "command", "consumeResult", "startExecution", "applyCommand", "finishExecution"],
};

export interface Write { store: string; method: string; args: unknown[]; result: unknown }

/** When a Runner is lost: right after its Nth durable write, or right after the first write a predicate picks. */
export type LoseAfter = number | ((write: Write) => boolean);

/** One Runner process: its writes, and its loss. */
export class Runner {
  dead = false;
  /** Its Router's handoff, once the Runner is shut down. */
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
    this.dead = true;
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
              if (!counted || (property === "claim" && settled === null)) return settled;
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
function sandbox(runner: Runner, run: (call: Omit<ToolCall, "runner">) => Promise<string>, sent: (command: string[]) => void): SandboxManager {
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
    prepare: async () => {}, checkWorkspace: async () => {}, dispose: async () => {},
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
 * a Runner drains the Session.
 */
export async function execute(scenario: Scenario, loseAfter: Array<LoseAfter | undefined> = [],
  shutDownAfter: Array<number | undefined> = []): Promise<Outcome> {
  const stores = createMemoryStores();
  const agent = await stores.agentStore.create({ tenantId: "tenant", name: "Pi", model: `${PROVIDER}/${MODELS[0]}`, system: "",
    runtime: "pi-agent", sandbox: { enabled: true } });
  const workspace = await stores.workspaceStore.create({ tenantId: "tenant" });
  const session = await stores.sessionStore.create({ tenantId: "tenant", agentId: agent.id, agent, workspaceId: workspace.id });
  for (const text of scenario.inputs) {
    await stores.pendingEventStore.enqueue(session.id, { type: "user.message", data: { content: [{ type: "text", text }] }, sessionThreadId: "sthr_primary" });
  }
  const provider: CustomProviderDefinition = { id: PROVIDER, name: "Scripted", api: "anthropic-messages", baseUrl: "https://model.example.invalid",
    apiKey: "controlled-test-key", models: MODELS.map((id) => ({ id, name: id, contextWindow: scenario.contextWindow ?? 200_000, maxTokens: 8192, input: ["text"] })) };
  const outcome: Outcome = { log: [], sessionId: session.id, stores, runners: [], requests: [], toolCalls: [], attempts: [], losses: [], commands: [], errors: [], deltas: [] };
  // The Redis stand-in all Runners share; it records every Delta as it is appended.
  const turnStreams = new InMemoryTurnStreamStore();
  const appendDelta = turnStreams.appendDelta.bind(turnStreams);
  turnStreams.appendDelta = async (sessionId, delta) => { outcome.deltas.push(delta); return appendDelta(sessionId, delta); };
  const readLog = async () => (await stores.eventLogStore.getEvents(session.id, { limit: 100_000 })).data;

  // A lost Runner's claim lapses: the next claim takes the input over.
  const lapse = (runner: Runner) => {
    const state = stores.pendingEventStore.snapshotState();
    for (const claim of state.claims.values()) if (claim.ownerId === runner.ownerId) claim.expiresAtMs = 0;
    stores.pendingEventStore.restoreState(state);
  };
  const startRunner = (index: number) => {
    const runner: Runner = new Runner(index, loseAfter[index], lapse, (store, method, args) =>
      store === "eventLogStore" && method === "append" && scenario.refuse?.(args[1] as { type: string; data: unknown }, run) === true,
      shutDownAfter[index]);
    let router!: SessionRouter;
    const run: Run = { crash: () => runner.lose(), runner: index, log: readLog,
      shutDown: (graceMs = 20_000) => { runner.handingOff ??= router.handOff(graceMs); },
      requestInterrupt: () => stores.pendingEventStore.requestInterrupt(session.id),
      stores, agentId: agent.id, sessionId: session.id };
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
    const pi = new PiAgentAdapter({ configureModelRuntime: (_input, runtime) => registerCustomProvider(runtime, provider, fetchModel) });
    const adapter: Adapter = { async run(input) {
      if (runner.dead) return GONE;
      outcome.attempts.push({ runner: index, input, log: await readLog() });
      return pi.run(input);
    } };
    router = new SessionRouter({ ...runner.stores({ ...stores, turnStreamStore: turnStreams }), eventStreamHub: new InProcessEventStreamHub(), resolveAdapter: () => adapter,
      sandboxManager: sandbox(runner, async (call) => {
        const toolCall = { ...call, runner: index };
        outcome.toolCalls.push(toolCall);
        return scenario.tool ? scenario.tool(toolCall, run) : `ran ${call.id}`;
      }, (command) => outcome.commands.push({ runner: index, command })),
      workspaceMount: { bucket: "agentry", agentName: "agentry-workspace", pvName: "agentry-workspace-oss", credentialProviderName: "agentry-oss-rw" },
      pendingClaimOwnerId: runner.ownerId, onDrainError: ({ error }) => outcome.errors.push({ runner: index, error }) });
    runner.shutDown = () => run.shutDown();
    outcome.runners.push(runner);
    return { runner, router, run };
  };

  for (let index = 0; ; index++) {
    if (index > 12) throw new Error("The Session was not drained after 12 Runners");
    const { runner, router, run } = startRunner(index);
    // The first Runner is woken by the input's arrival; each later one finds
    // the input its predecessor left in its pending scan.
    if (index === 0) void router.handleNewEvent(session.id, agent);
    else await router.recoverPendingEvents();
    const settled = await Promise.race([runner.died.then(() => "lost" as const), router.waitForIdle(30_000).then((idle) => idle ? "idle" as const : "stuck" as const)]);
    if (settled === "stuck") throw new Error(`Runner ${index} neither drained the Session nor was lost`);
    if (runner.handingOff && settled !== "lost") {
      // Its drains settled as it handed its Turns over; the process exits once the handoff is done.
      const detached = !await runner.handingOff;
      runner.exit();
      outcome.losses.push({ ...await lossOf(runner, session.id, await readLog(), scenario), detached });
      await scenario.afterLoss?.(run);
      continue;
    }
    if (settled === "idle" && await stores.pendingEventStore.peek(session.id)) {
      // A refused write stops the attempt (ADR-0020). The Runner stays up, and
      // the claim it no longer renews lapses after its lease.
      const refused = outcome.errors.some((error) => error.runner === index && error.error instanceof RefusedWrite);
      if (!refused) throw new Error(`Runner ${index} went idle and left the Session's input queued`);
      runner.lose();
    } else if (settled === "idle") break;
    outcome.losses.push(await lossOf(runner, session.id, await readLog(), scenario));
    await scenario.afterLoss?.(run);
  }
  outcome.log = await readLog();
  return outcome;
}

/**
 * The input of the Session a lost Runner held, or a Runner shut down handed
 * over, and its Turn's calls that had no result then. The claims it held on
 * Child Sessions are not the Session's.
 */
async function lossOf(runner: Runner, sessionId: string, log: StoredEvent[], scenario: Scenario): Promise<Loss> {
  type Claim = { event: { data: { content: Array<{ text: string }> } }; generation: number };
  let held: Claim | undefined;
  let released: Claim | undefined;
  for (const write of runner.writes) {
    if (write.store === "pendingEventStore" && write.args[0] !== sessionId) continue;
    if (write.method === "claim") { held = write.result as Claim; released = undefined; }
    else if (write.method === "ackCompletedTurn" && (write.result as { acknowledged: boolean }).acknowledged) held = undefined;
    else if (write.method === "releaseClaim" && write.result === true) { released = held; held = undefined; }
  }
  // A lost Runner's claim lapses; one shut down ends holding nothing, and the input it released is the one it handed over.
  const reason: PendingEventClaimEnd = runner.handingOff ? "released" : "expired";
  if (runner.handingOff) held = released;
  if (!held) return { runner: runner.index, reason, dangling: [] };
  const input = scenario.inputs.indexOf(held.event.data.content[0].text);
  const events = eventsOfInput(log, scenario, input);
  return { runner: runner.index, reason, input, generation: held.generation,
    completed: events.some((event) => event.type === "session.turn_completed"), dangling: dangling(events) };
}

/** The input's promotion and every event after it, up to the next input's promotion. */
export function eventsOfInput(log: StoredEvent[], scenario: Scenario, input: number): StoredEvent[] {
  const promotions = log.filter((event) => event.type === "user.message");
  const start = promotions.find((event) => textOf(event) === scenario.inputs[input]);
  if (!start) return [];
  const next = promotions.find((event) => event.seq > start.seq);
  return log.filter((event) => event.seq >= start.seq && (!next || event.seq < next.seq));
}

const textOf = (event: StoredEvent) => ((event.data as { content?: Array<{ text?: string }> }).content ?? [])[0]?.text;
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

/** Tools the Host runs itself, not the Sandbox: the delegation records say what their calls did. */
const HOST_TOOLS = new Set(["Agent", "get_subagent_result", "steer_subagent"]);

export interface Expected {
  /**
   * Calls a lost Runner left dangling that the takeover answers from the
   * delegation record they left (#251), instead of as of unknown outcome.
   */
  recorded?: string[];
}

/**
 * The assertions every resumed scenario meets (RECOVERY-MATRIX.md): each input
 * completes once, in its original Turn and in order, with no recovery error
 * the scenario does not expect; every call has exactly one result and only
 * calls left dangling by a lost Runner report an unknown outcome, unless their
 * record answers them; no tool runs twice; model steps continue from the log;
 * each takeover is marked once, with why it happened and the calls it found
 * dangling; and no lost Runner writes after it is lost.
 */
export function expectResumed(scenario: Scenario, outcome: Outcome, expected: Expected = {}): void {
  const { log } = outcome;
  // Each input completes exactly once, in the Turn its first attempt named, in order.
  const completions = log.filter((event) => event.type === "session.turn_completed");
  expect(completions).toHaveLength(scenario.inputs.length);
  scenario.inputs.forEach((_text, input) => {
    const events = eventsOfInput(log, scenario, input).filter((event) => event.type !== "subagent.result");
    const named = [...new Set(events.map(turnIdOf).filter((turnId) => turnId !== undefined))];
    expect(named, `input ${input} is one Turn`).toHaveLength(1);
    expect(events.filter((event) => event.type === "session.turn_completed").map(turnIdOf)).toEqual(named);
    expect(events.at(-1)?.type === "session.turn_completed" || events.at(-1)?.type === "session.status_idle").toBe(true);
  });
  // No error but the scenario's own: a recovery error only where it expects one (the takeover limit).
  const errorCodes = log.filter((event) => event.type === "session.error").map((event) => (event.data as { error: { code: string } }).error.code);
  expect(errorCodes.filter((code) => !(scenario.errors ?? []).includes(code))).toEqual([]);
  // Every call has exactly one result.
  const shown = displayed(log);
  const results = shown.filter((event) => event.type === "agent.tool_result" || event.type === "agent.mcp_tool_result");
  const calls = [...new Set(shown.filter((event) => event.type === "agent.tool_use" || event.type === "agent.mcp_tool_use")
    .map((event) => (event.data as { toolUseId: string }).toolUseId))];
  for (const call of calls) expect(results.filter((event) => (event.data as { toolUseId: string }).toolUseId === call), `results of ${call}`).toHaveLength(1);
  // "Outcome unknown" exactly for the calls a lost Runner left without a
  // result, but those whose delegation record answers them.
  const unknown = results.filter((event) => JSON.stringify(event.data).includes(OUTCOME_UNKNOWN_PREFIX))
    .map((event) => (event.data as { toolUseId: string }).toolUseId);
  const dangling = outcome.losses.flatMap((loss) => loss.dangling);
  const recorded = expected.recorded ?? [];
  for (const call of recorded) expect(dangling, `${call} was left dangling`).toContain(call);
  expect(new Set(unknown)).toEqual(new Set(dangling.filter((call) => !recorded.includes(call))));
  // A handoff leaves a call without a result only when its deadline detached the Turn.
  for (const loss of outcome.losses) if (loss.reason === "released" && !loss.detached) expect(loss.dangling).toEqual([]);
  // No tool runs twice; a Sandbox call with a real result ran once.
  const executions = outcome.toolCalls.map((call) => call.id);
  expect(executions).toEqual([...new Set(executions)]);
  const hostCalls = new Set(shown.filter((event) => HOST_TOOLS.has((event.data as { name?: string }).name ?? ""))
    .map((event) => (event.data as { toolUseId: string }).toolUseId));
  for (const call of calls.filter((id) => !unknown.includes(id) && !hostCalls.has(id))) expect(executions, `${call} ran`).toContain(call);
  // Model steps continue from the log: an attempt continues exactly when its
  // input is in the Turn's native history, from the steps the log counts.
  // A Child Session's attempts are its own Turns, not the Session's.
  for (const attempt of outcome.attempts.filter((attempt) => attempt.input.sessionId === outcome.sessionId)) {
    const turn = attempt.log.filter((event) => turnIdOf(event) === attempt.input.turnId);
    const steps = turn.filter((event) => event.type === "span.model_request_start").length;
    expect(attempt.input.resume !== undefined, `attempt of runner ${attempt.runner} continues`).toBe(turn.some(isUser));
    expect(attempt.input.resume?.completedModelSteps ?? 0, `steps of runner ${attempt.runner}`).toBe(steps);
  }
  // No double count: each model step and its usage is recorded once, and no
  // more often than the model was asked; every committed answer counts.
  const starts = log.filter((event) => event.type === "span.model_request_start");
  const ends = log.filter((event) => event.type === "span.model_request_end");
  const steps = outcome.requests.filter((sent) => !sent.summary).length;
  for (const spans of [starts, ends]) {
    const ids = spans.map((event) => (event.data as { id: string }).id);
    expect(ids).toEqual([...new Set(ids)]);
    expect(spans.length).toBeLessThanOrEqual(steps);
  }
  expect(starts.length).toBeGreaterThanOrEqual(log.filter(isAssistant).length);
  // One marker per takeover, with the reason and the calls it found dangling.
  const markers = log.filter((event) => event.type === "session.turn_resumed");
  const markerOf = (input: number, generation: number) => eventsOfInput(log, scenario, input)
    .filter((event) => event.type === "session.turn_resumed" && (event.data as { generation: number }).generation === generation);
  for (const marker of markers) expect(Object.keys(marker.data as object).sort()).toEqual(["danglingToolUseIds", "generation", "reason", "turnId"]);
  const takeovers = outcome.losses.filter((loss) => loss.input !== undefined);
  for (const loss of takeovers) {
    const found = markerOf(loss.input!, loss.generation! + 1);
    expect(found.length, `markers of generation ${loss.generation! + 1}`).toBeLessThanOrEqual(1);
    for (const marker of found) expect(marker.data).toMatchObject({ reason: loss.reason, danglingToolUseIds: loss.dangling });
  }
  // The takeover that drained the Session marked itself, unless it only
  // acknowledged a completed Turn.
  const last = takeovers.at(-1);
  if (last && outcome.losses.at(-1) === last) expect(markerOf(last.input!, last.generation! + 1)).toHaveLength(last.completed ? 0 : 1);
  expect(markers.length).toBeLessThanOrEqual(takeovers.length);
  // No Runner reports a failure but a write the scenario refused: a lost one
  // is gone before it could, and the one that takes over never loses its
  // claim or a write.
  expect(outcome.errors.filter(({ error }) => !(error instanceof RefusedWrite))).toEqual([]);
  // Every row came from a write a live Runner made: an append, the idle its
  // acknowledgement committed, or a delegation transaction.
  const written = new Set(outcome.runners.flatMap((runner) => runner.writes.flatMap((write) => rowsOf(write)
    .filter((row) => row.sessionId === outcome.sessionId).map((row) => row.seq))));
  expect(log.filter((event) => !written.has(event.seq)).map((event) => event.type)).toEqual([]);
}

/** The rows a durable write committed to the event log. */
function rowsOf(write: Write): Array<{ sessionId: string; seq: number }> {
  switch (write.method) {
    case "append": case "consumeResult": return [write.result as StoredEvent];
    case "ackCompletedTurn": {
      const { idleEvent } = write.result as { idleEvent?: StoredEvent };
      return idleEvent ? [idleEvent] : [];
    }
    // An execution's end notifies its caller in the same transaction.
    case "startExecution": case "finishExecution": {
      const execution = write.result as DelegationExecution | null;
      return execution?.notificationEventSeq === undefined ? [] : [{ sessionId: execution.callerSessionId, seq: execution.notificationEventSeq }];
    }
    default: return [];
  }
}

/**
 * Lose the first Runner after each durable write the scenario makes, one
 * execution per write, and check every execution resumes. The writes are
 * those of an execution that loses no Runner, which must itself pass.
 */
export async function sweep(scenario: Scenario, also: (outcome: Outcome, write: number) => void = () => {}): Promise<void> {
  const writes = await writesOf(scenario);
  it("has a durable write to lose the Runner after", () => expect(writes.length).toBeGreaterThan(0));
  it.each(writes.map((write, index) => [rowOf(writes, index), index + 1, describeWrite(write)] as const))("%s Runner lost after write %i (%s): the Turn resumes and completes", async (_row, n) => {
    const outcome = await execute(scenario, [n]);
    expectResumed(scenario, outcome);
    also(outcome, n);
  });
}

/**
 * Shut the first Runner down right after each durable write the scenario
 * makes (#254), one execution per write, and check every execution hands the
 * Turn over cleanly: its tools finish within the grace period, so no call's
 * outcome is unknown.
 */
export async function handoffSweep(scenario: Scenario): Promise<void> {
  const writes = await writesOf(scenario);
  it.each(writes.map((write, index) => [`F@${rowOf(writes, index)}`, index + 1, describeWrite(write)] as const))("%s Runner shut down after write %i (%s): the Turn is handed over and completes", async (_row, n) => {
    const outcome = await execute(scenario, [], [n]);
    expectResumed(scenario, outcome);
    expect(outcome.losses).toEqual([expect.objectContaining({ runner: 0, reason: "released", detached: false, dangling: [] })]);
    // Whatever the takeover found, it was handed over, never lost.
    expect(outcome.log.filter((event) => event.type === "session.turn_resumed").map((event) => (event.data as { reason: string }).reason)
      .filter((reason) => reason !== "released")).toEqual([]);
  });
}

/** Run a test file's scenarios with Pi settings of their own. */
export async function usePiSettings(): Promise<void> {
  const agentDir = await piAgentDir();
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir.dir);
  afterAll(async () => { vi.unstubAllEnvs(); await agentDir.remove(); });
}

/** Runner 0's durable writes when no Runner is lost: the crash points of a sweep. */
export async function writesOf(scenario: Scenario): Promise<Write[]> {
  const outcome = await execute(scenario);
  expectResumed(scenario, outcome);
  return outcome.runners[0].writes;
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
  if (write.method !== "append") return write.method;
  const stored = write.result as StoredEvent;
  const data = stored.data as { entry?: { type?: string; message?: { role?: string; content?: Array<{ type: string }>; stopReason?: string } } };
  const before = writes.slice(0, index).map((earlier) => earlier.result as StoredEvent);
  const sinceInput = before.slice(before.map((earlier) => earlier?.type).lastIndexOf("user.message") + 1);
  if (stored.type === "user.message") return "A2";
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
