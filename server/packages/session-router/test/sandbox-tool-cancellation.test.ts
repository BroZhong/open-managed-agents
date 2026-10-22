import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createMemoryStores } from "@oma-server/store-memory";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { DefaultSandboxManager, FakeSandboxClient, type SandboxExecChunk, type SandboxExecOptions, type SandboxManager, type SandboxSession } from "@oma-server/sandbox";
import type { SandboxActivity } from "@oma-server/store";
import { SANDBOX_WORKSPACE_ROOT, type Adapter, type ExecExitResult } from "@open-managed-agents/adapter-core";
import { journalWriter } from "@open-managed-agents/adapter-mock";
import { SessionRouter } from "../src/session-router.js";
// The production Pi sandbox tool and its in-Sandbox wrapper, run as real local
// processes: cancellation is a protocol between the two, not a Router detail.
import { buildCustomTools } from "../../../../adapter/packages/pi-agent/src/custom-tools.js";
import { LocalToolExecutor } from "../../../../adapter/packages/tool-executor-local/src/local-tool-executor.js";
// The production filesystem helpers the Sandbox client runs as commands.
import { createSandboxFileSystem } from "../../sandbox/src/sandbox-file-system.js";

process.env.OMA_PI_TOOL_MODULE = realpathSync(new URL(
  "../../../../adapter/packages/pi-agent/node_modules/@earendil-works/pi-coding-agent/dist/index.js", import.meta.url));

const BASH = "printf ready; sleep 1; printf survived > survived.txt";

interface SandboxCommand { command: string[]; stdout: string; exit?: ExecExitResult }

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "oma-tool-cancellation-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** A Sandbox whose commands are real local processes, recorded as sent. */
function localSandbox() {
  const local = new LocalToolExecutor({ root });
  const commands: SandboxCommand[] = [];
  let disposed = false;
  const session: SandboxSession = {
    fileSystem: local.fileSystem,
    async *exec(command, options) {
      const sent: SandboxCommand = { command, stdout: "" };
      commands.push(sent);
      for await (const chunk of local.exec(command, { ...options, onExit: (exit) => { sent.exit = exit; options?.onExit?.(exit); } })) {
        if (chunk.stream === "stdout") sent.stdout += chunk.text;
        yield chunk;
      }
    },
    readFile: (path) => local.readFile(path),
    writeFile: (path, content) => local.writeFile(path, content),
    list: (glob) => local.list(glob),
    prepare: async () => {},
    checkWorkspace: async () => {},
    dispose: async () => { disposed = true; },
  };
  const manager: SandboxManager = { open: () => session, list: async () => [], reclaim: async () => {} };
  return { manager, commands, disposed: () => disposed };
}

/**
 * The production Sandbox Session over a Sandbox whose commands, filesystem
 * helpers included, are real local processes. Its exit evidence decides the
 * Turn's Workspace check and whether the Sandbox activity is released.
 */
function managedSandbox(options: {
  onCommand?: (sent: SandboxCommand) => void;
  /** A transport that loses a command's exit reports none. */
  losesExit?: (sent: SandboxCommand) => boolean;
} = {}) {
  const local = new LocalToolExecutor({ root });
  const commands: SandboxCommand[] = [];
  const finished: SandboxActivity[] = [];
  const sessions: SandboxSession[] = [];
  class LocalProcessSandbox extends FakeSandboxClient {
    private readonly files = createSandboxFileSystem({
      exec: (command, execOptions) => this.exec("", command, execOptions),
      writeFileBytes: (path, content) => writeFile(path, content),
      remove: (path) => rm(path, { force: true }),
    });
    fileSystem() { return this.files; }
    override async *exec(_id: string, command: string[], execOptions?: SandboxExecOptions): AsyncIterable<SandboxExecChunk> {
      const sent: SandboxCommand = { command, stdout: "" };
      commands.push(sent);
      options.onCommand?.(sent);
      // The Sandbox's Workspace root is the local directory.
      const cwd = execOptions?.cwd === undefined ? undefined : relative(SANDBOX_WORKSPACE_ROOT, execOptions.cwd) || ".";
      const onExit = (exit: ExecExitResult) => { sent.exit = exit; if (!options.losesExit?.(sent)) execOptions?.onExit?.(exit); };
      for await (const chunk of local.exec(command, { ...execOptions, cwd, onExit })) {
        if (chunk.stream === "stdout") sent.stdout += chunk.text;
        yield chunk;
      }
    }
  }
  class Sandboxes extends DefaultSandboxManager {
    override async beginActivity() { return true; }
    override async finishActivity(activity: SandboxActivity) { finished.push(activity); }
    override open(...args: Parameters<DefaultSandboxManager["open"]>) {
      const session = super.open(...args);
      sessions.push(session);
      return session;
    }
  }
  const manager = new Sandboxes({ sandboxClient: new LocalProcessSandbox(), provisionSources: {} });
  return { manager, commands, finished, sessions, disposed: () => false };
}

/** Pi's managed bash, driven with the Turn signal exactly as Pi aborts its running tools. */
function bashAdapter() {
  const ready = deferred();
  const aborted = deferred();
  const settled = deferred<{ error?: Error }>();
  const adapter: Adapter = {
    async run(input) {
      input.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
      const bash = buildCustomTools(input.toolExecutor!).find((tool) => tool.name === "bash")!;
      // A tool runs only once its call is committed (ADR-0020).
      await journalWriter(input)({ id: "call", timestamp: new Date().toISOString(), type: "agent.tool_use",
        toolUseId: "bash-1", name: "bash", input: { command: BASH } });
      try {
        await bash.execute("bash-1", { command: BASH }, input.signal, (update) => {
          if (update.content.some((block) => block.type === "text" && block.text.includes("ready"))) ready.resolve();
        }, {} as never);
        settled.resolve({});
      } catch (error) {
        settled.resolve({ error: error as Error });
      }
      return "finished";
    },
  };
  return { adapter, ready: ready.promise, aborted: aborted.promise, settled: settled.promise };
}

async function harness<S extends { manager: SandboxManager } = ReturnType<typeof localSandbox>>(
  adapter: Adapter, options: { leaseMs?: number; sandbox?: S } = {},
) {
  const stores = createMemoryStores();
  const sandbox = options.sandbox ?? localSandbox() as unknown as S;
  const agent = await stores.agentStore.create({ tenantId: "tenant", name: "Test", model: "test", system: "test", runtime: "pi-agent", sandbox: { enabled: true } });
  const workspace = await stores.workspaceStore.create({ tenantId: "tenant" });
  const session = await stores.sessionStore.create({ tenantId: "tenant", agentId: agent.id, agent, workspaceId: workspace.id });
  const errors: unknown[] = [];
  // A Delegation Store makes the Router fence the Sandbox executor, as in production.
  const router = new SessionRouter({
    ...stores, eventStreamHub: new InProcessEventStreamHub(), resolveAdapter: () => adapter,
    sandboxManager: sandbox.manager,
    workspaceMount: { bucket: "agentry", agentName: "agentry-workspace", pvName: "agentry-workspace-oss", credentialProviderName: "agentry-oss-rw" },
    pendingClaimLeaseMs: options.leaseMs ?? 30000,
    pendingClaimRenewIntervalMs: options.leaseMs ? Math.floor(options.leaseMs / 3) : 1000,
    pendingClaimRetryMinMs: 10, pendingClaimRetryMaxMs: 20,
    onDrainError: ({ error }) => errors.push(error),
  });
  await stores.pendingEventStore.enqueue(session.id, {
    type: "user.message", data: { content: [{ type: "text", text: "run it" }] }, sessionThreadId: "sthr_primary",
  });
  const log = async () => (await stores.eventLogStore.getEvents(session.id, { limit: 1000 })).data;
  return { stores, sandbox, agent, session, router, log, errors };
}

const isSigterm = (sent: SandboxCommand) => sent.command.some((arg) => arg.includes("SIGTERM"));
const frames = (sent: SandboxCommand) => sent.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; pid?: number });
const survived = () => readFile(join(root, "survived.txt"), "utf8").then(() => true, () => false);
const afterBash = () => new Promise((resolve) => setTimeout(resolve, 1400));
const isWrapper = (sent: SandboxCommand) => sent.command.includes("--input-type=module");
/** The filesystem operation a Sandbox command performs, if it is one of the helpers. */
const fileOperation = (sent: SandboxCommand) => {
  const request = sent.command[1] === "--input-type=commonjs" ? sent.command.at(-1) : undefined;
  return request ? (JSON.parse(request) as { operation: string }).operation : undefined;
};

describe("cancelling a running Sandbox tool through the fenced executor", () => {
  it("delivers SIGTERM to the tool wrapper on Interrupt and observes its cancellation and exit", async () => {
    const tool = bashAdapter();
    const h = await harness(tool.adapter);
    const running = h.router.handleNewEvent(h.session.id, h.agent);
    await tool.ready;

    expect(h.router.interrupt(h.session.id)).toBe(true);
    const { error } = await tool.settled;
    await running;

    const [wrapper, ...rest] = h.sandbox.commands;
    const accepted = frames(wrapper).find((frame) => frame.type === "accepted");
    expect(rest.filter(isSigterm).map((sent) => sent.command.at(-1))).toEqual([String(accepted?.pid)]);
    // The wrapper aborted the native tool and settled it as cancelled, then exited on its own.
    expect(frames(wrapper).at(-1)?.type).toBe("cancelled");
    expect(wrapper.exit).toEqual({ exitCode: 1 });
    expect(error?.message).toBe("ready\n\nCommand aborted");
    await afterBash();
    expect(await survived()).toBe(false);
    expect((await h.log()).filter((event) => event.type === "session.turn_aborted")).toHaveLength(1);
    expect(h.errors).toEqual([]);
  }, 15000);

  it("sends nothing to the running execution once the Session is terminated", async () => {
    const tool = bashAdapter();
    const h = await harness(tool.adapter);
    const running = h.router.handleNewEvent(h.session.id, h.agent);
    await tool.ready;

    await h.stores.sessionStore.terminate(h.session.id);
    await h.router.terminateSession(h.session.id);
    await tool.aborted;
    await tool.settled;
    await running;

    // No SIGTERM helper and no transport kill: disposing the Sandbox is
    // termination's own cleanup, so the execution was left to run undisturbed.
    expect(h.sandbox.commands).toHaveLength(1);
    expect(frames(h.sandbox.commands[0]).at(-1)?.type).toBe("result");
    expect(h.sandbox.commands[0].exit).toEqual({ exitCode: 0 });
    expect(h.sandbox.disposed()).toBe(true);
  }, 15000);

  it("sends nothing to the running execution after the lease is lost", async () => {
    const tool = bashAdapter();
    const h = await harness(tool.adapter, { leaseMs: 300 });
    const renew = h.stores.pendingEventStore.renewClaim.bind(h.stores.pendingEventStore);
    let leaseHeld = true;
    h.stores.pendingEventStore.renewClaim = async (...args) => leaseHeld ? renew(...args) : { renewed: false, interruptRequested: false };
    const running = h.router.handleNewEvent(h.session.id, h.agent);
    await tool.ready;

    leaseHeld = false;
    await tool.aborted;
    await tool.settled;
    await running;

    // The Turn now belongs to whichever Runner claims it next; this one
    // neither asks the tool to stop nor kills it.
    expect(h.sandbox.commands).toHaveLength(1);
    expect(frames(h.sandbox.commands[0]).at(-1)?.type).toBe("result");
    expect(h.sandbox.commands[0].exit).toEqual({ exitCode: 0 });
    expect(h.errors.some((error) => (error as Error).name === "PendingLeaseLostError")).toBe(true);
    leaseHeld = true;
    expect(await h.router.waitForIdle(5000)).toBe(true);
  }, 15000);

  it("F2 sends nothing to the running execution when the handoff deadline detaches its Turn", async () => {
    const tool = bashAdapter();
    const h = await harness(tool.adapter);
    const running = h.router.handleNewEvent(h.session.id, h.agent);
    await tool.ready;

    // The Runner shuts down and its grace period ends while bash still runs.
    expect(await h.router.handOff(0)).toBe(false);
    await tool.aborted;
    await tool.settled;
    await running;

    // The Turn goes to the next claim as it stands: the process is neither
    // asked to stop nor killed, and finishes what it was doing.
    expect(h.sandbox.commands).toHaveLength(1);
    expect(frames(h.sandbox.commands[0]).at(-1)?.type).toBe("result");
    expect(h.sandbox.commands[0].exit).toEqual({ exitCode: 0 });
    expect(await survived()).toBe(true);
    expect((await h.log()).filter((event) => event.type === "session.turn_aborted" || event.type === "session.turn_completed")).toEqual([]);
    expect(await h.stores.pendingEventStore.headClaimable(h.session.id)).toBe(true);
    expect(h.errors).toEqual([]);
  }, 15000);
});

describe("the Sandbox settlement of an Interrupted Turn", () => {
  /** An Interrupt while the Sandbox performs the tool's `operation`, with the Turn's outcome. */
  async function interruptDuring(operation: string) {
    const tool = bashAdapter();
    let interrupt = () => {};
    const sandbox = managedSandbox({ onCommand: (sent) => { if (fileOperation(sent) === operation) interrupt(); } });
    const h = await harness(tool.adapter, { sandbox });
    interrupt = () => { h.router.interrupt(h.session.id); };
    const running = h.router.handleNewEvent(h.session.id, h.agent);
    const { error } = await tool.settled;
    await running;
    return { ...h, error };
  }

  it.each([
    ["its request file is created", "createTempFile"],
    ["its request is written", "writeFile"],
  ])("leaves the Turn settled when an Interrupt lands while %s", async (_, operation) => {
    const h = await interruptDuring(operation);

    // The operation finished before the tool reported the Interrupt; the wrapper never started.
    expect(h.error?.message).toBe("Session interrupted");
    expect(h.sandbox.commands.some(isWrapper)).toBe(false);
    const log = await h.log();
    expect(log.filter((event) => event.type === "session.turn_aborted")).toHaveLength(1);
    expect(log.filter((event) => event.type === "session.error")).toEqual([]);
    expect(h.sandbox.sessions.map((session) => session.executionSettled?.())).toEqual([true]);
    expect(h.sandbox.finished).toHaveLength(1);
    expect(h.errors).toEqual([]);
  }, 15000);

  it("leaves the Turn settled after an Interrupt whose tool cancellation was confirmed", async () => {
    const tool = bashAdapter();
    const h = await harness(tool.adapter, { sandbox: managedSandbox() });
    const running = h.router.handleNewEvent(h.session.id, h.agent);
    await tool.ready;

    expect(h.router.interrupt(h.session.id)).toBe(true);
    const { error } = await tool.settled;
    await running;

    // The wrapper reported the cancellation and exited.
    expect(error?.message).toBe("ready\n\nCommand aborted");
    expect(h.sandbox.commands.find(isWrapper)?.exit).toEqual({ exitCode: 1 });
    const log = await h.log();
    expect(log.filter((event) => event.type === "session.turn_aborted")).toHaveLength(1);
    expect(log.filter((event) => event.type === "session.error")).toEqual([]);
    expect(h.sandbox.sessions.map((session) => session.executionSettled?.())).toEqual([true]);
    expect(h.sandbox.finished).toHaveLength(1);
    expect(h.errors).toEqual([]);
  }, 15000);

  it("keeps the Turn uncertain when the cancelled tool's exit is not observed", async () => {
    const tool = bashAdapter();
    // The transport loses the wrapper's exit: the Runner cannot tell whether it stopped.
    const sandbox = managedSandbox({ losesExit: isWrapper });
    const h = await harness(tool.adapter, { sandbox });
    const running = h.router.handleNewEvent(h.session.id, h.agent);
    await tool.ready;

    expect(h.router.interrupt(h.session.id)).toBe(true);
    const { error } = await tool.settled;
    await running;

    expect(error?.message).toBe("Sandbox tool cancellation was not confirmed");
    const log = await h.log();
    expect(log.filter((event) => event.type === "session.turn_aborted")).toHaveLength(1);
    expect(log.filter((event) => event.type === "session.error").map((event) => (event.data as { error: { code: string } }).error.code))
      .toEqual(["workspace_storage_error"]);
    expect(h.sandbox.sessions.map((session) => session.executionSettled?.())).toEqual([false]);
    // Unknown execution never requests idle (ADR-0019).
    expect(h.sandbox.finished).toEqual([]);
  }, 15000);
});
