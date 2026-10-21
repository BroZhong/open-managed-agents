import type {
  DelegationCaller, DelegationExecution, DelegationOutcome, DelegationStore,
  DelegationWait, DelegationWaitConfig, PendingEventFence, PendingEventStore, Session,
  SessionStore, StoredEvent,
} from "@oma-server/store";
import { PendingEventClaimLostError, presentContextData, presentEvent } from "@oma-server/store";
import type {
  AdapterExecution, AgentToolResultEvent, HostSubagentCapability,
  SubagentCallContext, ToolExecutor, ToolFileSystem,
} from "@open-managed-agents/adapter-core";
import type { JournalEvent, TurnJournal } from "./turn-journal.js";
import type { DanglingCallResolver, RepairResult } from "./dangling-call-results.js";

export interface DelegationRun {
  session: Session;
  turnId: string;
  fence: PendingEventFence;
  signal: AbortSignal;
  apiKeyId?: string;
  effectiveConfig?: Record<string, unknown>;
  /** The attempt's write entry; wait transitions and recovered results are recorded there. */
  journal: TurnJournal;
}

interface CoordinatorDeps {
  store: DelegationStore;
  pending: PendingEventStore;
  sessions: SessionStore;
  /** Input may be claimable: any Runner may start it. */
  wake(sessionId: string): void;
  /** The owner of the Session's running Turn should re-read its durable state now. */
  check(sessionId: string): void;
  maxSteps: number;
  /** Fallback poll of a synchronous wait, for a lost child-completion hint. */
  pollMs?: number;
}

/**
 * A wait learns of its child's completion from the check hint the child's
 * Runner sends the parent (completeTurn); polling only covers a lost hint.
 */
const DEFAULT_WAIT_POLL_MS = 2_000;

export const isTerminalExecution = (execution: Pick<DelegationExecution, "status">): boolean =>
  execution.status !== "queued" && execution.status !== "running";

/** Coordination only; every child is executed by the ordinary Session Router. */
export class DelegationCoordinator {
  /** The synchronous waits of each calling Session's running Turn on this Runner. */
  private readonly waits = new Map<string, Set<WaitWakeup>>();

  constructor(private readonly deps: CoordinatorDeps) {}

  /** Re-read the executions a Session's running Turn waits on now. */
  recheckWaits(sessionId: string): void {
    for (const wakeup of this.waits.get(sessionId) ?? []) wakeup.notify();
  }

  /**
   * An ended execution frees a slot of its parent's concurrency limit. Its
   * queued siblings do not poll for one: wake them now.
   */
  async wakeChildrenWaitingForSlot(ended: DelegationExecution): Promise<void> {
    for (const execution of await this.deps.store.list(ended.tenantId, ended.callerSessionId)) {
      if (execution.status === "queued") this.deps.wake(execution.childId);
    }
  }

  private caller(run: DelegationRun, toolUseId: string): DelegationCaller {
    return {
      tenantId: run.session.tenantId,
      callerSessionId: run.session.id,
      callerTurnId: run.turnId,
      callerToolUseId: toolUseId,
    };
  }

  async assertOwner(run: DelegationRun): Promise<void> {
    run.signal.throwIfAborted();
    await this.assertClaim(run);
  }

  /** The durable claim alone; an Interrupted Turn still holds it until acknowledged. */
  async assertClaim(run: DelegationRun): Promise<void> {
    if (!await this.deps.pending.ownsClaim(
      run.session.id, run.fence.eventId, run.fence,
    )) throw new PendingEventClaimLostError(run.session.id, run.fence.eventId, run.fence.ownerId, run.fence.generation);
  }

  capability(run: DelegationRun): HostSubagentCapability {
    if (run.session.delegation) throw new Error("Child Sessions cannot receive delegation capabilities");
    return {
      maxModelSteps: this.deps.maxSteps,
      delegate: async (input, context) => {
        await this.assertOwner(run);
        if (run.session.delegation) throw new Error("Nested delegation is not supported");
        if ("model" in input) throw new Error("Delegated model overrides are not supported; children inherit the calling parent Turn model");
        const parentModel = run.effectiveConfig?.model;
        if (typeof parentModel !== "string" || !parentModel.trim()) throw new Error("Parent Turn model has not been resolved");
        if (run.session.agent.sandbox?.enabled === false) throw new Error("Delegation requires a managed Sandbox");
        if ("maxSteps" in input || "max_steps" in input) throw new Error("Delegated budget overrides are not supported; the Host assigns the execution budget");
        const maxSteps = this.deps.maxSteps;
        const execution = await this.deps.store.accept({
          ...this.caller(run, context.toolUseId),
          prompt: input.prompt,
          mode: input.runInBackground ? "async" : "sync",
          resume: input.resume,
          parentModel,
          thinking: input.thinking,
          maxSteps,
          apiKeyId: run.apiKeyId,
          sandboxSessionId: run.session.id,
          parentThinking: waitConfig(run).thinking,
        }, run.fence);
        // Persist the wait before waitForResult wakes the child, so a replacement
        // owner resumes this Turn even if the child finishes after this one is lost.
        if (execution.mode === "sync") {
          await this.saveWait(run, execution, context);
          return this.waitForResult(run, execution, context.toolUseId);
        }
        this.deps.wake(execution.childId);
        return this.readResult(execution);
      },
      getResult: async (input, context) => {
        await this.assertOwner(run);
        const execution = await this.queriedExecution(run.session, run.fence.eventId, context.toolUseId, input);
        if (!execution) throw new Error("Child Session or execution not found; legacy plugin child IDs cannot be resumed");
        // A terminal query also records its consumption intent. Only the
        // eventual durable tool result consumes/suppresses its async delivery.
        if (input.wait || isTerminalExecution(execution)) await this.saveWait(run, execution, context);
        return input.wait ? this.waitForResult(run, execution, context.toolUseId) : this.readResult(execution);
      },
      steer: async (input, context) => {
        await this.assertOwner(run);
        const command = await this.deps.store.command({
          ...this.caller(run, context.toolUseId), ...input, kind: "steer",
        }, run.fence);
        this.deps.wake(command.childId);
        return command;
      },
    };
  }

  /** The execution a get_subagent_result call reads: the one its wait fixed, else the one its arguments select. */
  private async queriedExecution(
    session: Pick<Session, "id" | "tenantId">, pendingEventId: string, toolUseId: string,
    input: { childId: string; executionId?: string },
  ): Promise<DelegationExecution | null> {
    const priorWait = (await this.deps.store.listWaits(session.id, pendingEventId))
      .find((wait) => wait.callerToolUseId === toolUseId);
    return this.deps.store.get(session.tenantId, session.id, input.childId, priorWait?.executionId ?? input.executionId);
  }

  /**
   * The result of each delegation tool, by name, for a call a takeover finds
   * without one (#251): what the call's durable record says, as the tool
   * returns it. Told its outcome is unknown, the Agent would delegate again
   * under a new call id, which the (calling Turn, tool use) idempotency key
   * cannot recognise, and create a second child. A call that left no record
   * gets no result here and stays of unknown outcome. A call answered here is
   * not answered by its wait as well: the plan resumes the calls that have a
   * wait and repairs only the others.
   */
  danglingCallResolvers(): Record<string, DanglingCallResolver> {
    const sessionOf = async (sessionId: string) => {
      const session = await this.deps.sessions.getById(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);
      return session;
    };
    return {
      // The Child Session and Delegation Execution the call created or resumed.
      Agent: async (call, scope) => {
        const { tenantId } = await sessionOf(scope.sessionId);
        const [execution] = await this.deps.store.listExecutions(tenantId, {
          callerSessionId: scope.sessionId, callerTurnId: scope.turnId, callerToolUseId: call.toolUseId, limit: 1,
        });
        return execution && toolResult(await this.readResult(execution));
      },
      // The selected execution as it is now. A wait the call recorded resumes
      // instead, waiting again if the call asked to wait.
      get_subagent_result: async (call, scope) => {
        const { childId, executionId } = call.input ?? {};
        if (typeof childId !== "string" || (executionId !== undefined && typeof executionId !== "string")) return undefined;
        const session = await sessionOf(scope.sessionId);
        const execution = await this.queriedExecution(session, scope.pendingEventId, call.toolUseId,
          { childId, ...(executionId ? { executionId } : {}) });
        return execution ? toolResult(await this.readResult(execution)) : undefined;
      },
      // The command the call issued, with the status it has reached. The
      // child it names bounds the search; the call's identity selects it.
      steer_subagent: async (call, scope) => {
        const { childId } = call.input ?? {};
        if (typeof childId !== "string") return undefined;
        const { tenantId } = await sessionOf(scope.sessionId);
        for (const execution of await this.deps.store.listExecutions(tenantId, { childId })) {
          const command = (await this.deps.store.listCommands(execution.id)).find((candidate) =>
            candidate.callerSessionId === scope.sessionId && candidate.callerTurnId === scope.turnId &&
            candidate.callerToolUseId === call.toolUseId);
          if (command) return toolResult(command);
        }
        return undefined;
      },
    };
  }

  private async saveWait(run: DelegationRun, execution: DelegationExecution, context: SubagentCallContext): Promise<void> {
    await this.deps.store.saveWait({
      ...this.caller(run, context.toolUseId), executionId: execution.id,
      parentPendingEventId: run.fence.eventId, config: waitConfig(run),
    }, run.fence);
  }

  /**
   * Wait for the child execution to end. The child is woken once, when the
   * wait starts (also after a takeover resumes it); the pending scan covers a
   * lost wake. A lost lease aborts the Turn signal, which ends the wait, so
   * ownership is not polled here.
   */
  async waitForResult(run: DelegationRun, execution: DelegationExecution, toolUseId: string): Promise<Record<string, unknown>> {
    await this.recordStatus(run, "waiting", toolUseId);
    await run.journal.flush();
    // Registered before the first read, so a hint that arrives during a read
    // makes the next wait return at once.
    const wakeup = new WaitWakeup();
    const sessionWaits = this.waits.get(run.session.id) ?? new Set<WaitWakeup>();
    sessionWaits.add(wakeup);
    this.waits.set(run.session.id, sessionWaits);
    try {
      for (let woken = false; ; woken = true) {
        const current = await this.deps.store.get(
          run.session.tenantId, run.session.id, execution.childId, execution.id,
        );
        if (!current) throw new Error("Delegation execution disappeared");
        if (isTerminalExecution(current)) return this.readResult(current);
        if (!woken) this.deps.wake(current.childId);
        await wakeup.next(this.deps.pollMs ?? DEFAULT_WAIT_POLL_MS, run.signal);
      }
    } finally {
      sessionWaits.delete(wakeup);
      if (!sessionWaits.size && this.waits.get(run.session.id) === sessionWaits) this.waits.delete(run.session.id);
      if (!run.signal.aborted && !(await this.deps.store.listWaits(run.session.id, run.fence.eventId))
        .some((wait) => wait.status === "waiting")) {
        await this.recordStatus(run, "running", toolUseId);
        await run.journal.flush();
      }
    }
  }

  private async readResult(execution: DelegationExecution): Promise<Record<string, unknown>> {
    const commands = (await this.deps.store.listCommands(execution.id)).map((command) => ({
      id: command.id, kind: command.kind, message: command.message, status: command.status,
      createdAt: command.createdAt, appliedEventSeq: command.appliedEventSeq,
    }));
    return { ...executionResult(execution), commands };
  }

  /**
   * Record that the Turn starts or stops waiting on the wait of one tool call.
   * A wait belongs to exactly one tool call of one pending input, so that
   * pair and the direction name each transition: an attempt that resumes the
   * same wait after a Runner loss records it again, and the event log returns
   * the original row instead of a second one.
   */
  private async recordStatus(run: DelegationRun, status: "waiting" | "running", toolUseId: string): Promise<void> {
    await this.assertOwner(run);
    await this.deps.sessions.updateStatusIfClaimed(run.session.id, status, run.fence);
    run.journal.record({ type: `session.status_${status}`, data: { turnId: run.turnId } },
      `pending:${run.fence.eventId}:status_${status}:${encodeURIComponent(toolUseId)}`);
  }

  /**
   * Complete the exact original tool, under the new owner after a restart.
   * The event log already holds the requesting tool call: the Adapter commits
   * each native message before running its tools.
   */
  async recoverWaits(run: DelegationRun, waits: DelegationWait[]): Promise<void> {
    for (const wait of waits) {
      if (wait.status !== "waiting") continue;
      const execution = await this.deps.store.getExecution(run.session.tenantId, wait.executionId);
      if (!execution) throw new Error("Waiting execution not found");
      const result = await this.waitForResult(run, execution, wait.callerToolUseId);
      const event: AgentToolResultEvent = {
        id: `delegation_result_${wait.executionId}_${wait.callerToolUseId}`,
        timestamp: new Date().toISOString(), type: "agent.tool_result", toolUseId: wait.callerToolUseId,
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError: executionResultIsError(result),
      };
      // The journal's append consumes the wait (consumeResult) as it writes.
      run.journal.record({ type: event.type, data: { ...event, turnId: run.turnId }, apiKeyId: run.apiKeyId },
        `pending:${run.fence.eventId}:delegation_result:${wait.callerToolUseId}`);
      await run.journal.flush();
    }
  }

  /**
   * Append a tool result that answers one of the Turn's waits by consuming the
   * wait's delegation result, which suppresses its asynchronous delivery. Null
   * when the event answers no consumable wait. Runs inside the journal's
   * append, so the running transition it records is written by the next flush,
   * ahead of anything recorded after it.
   */
  async consumeResult(run: DelegationRun, event: JournalEvent): Promise<StoredEvent | null> {
    const result = event.type === "agent.tool_result" ? event.data as Record<string, unknown>
      : presentContextData(event.type, event.data).find(item => item.type === "agent.tool_result")?.data;
    if (!result) return null;
    const toolUseId = result.toolUseId as string;
    const wait = (await this.deps.store.listWaits(run.session.id, run.fence.eventId))
      .find((item) => item.callerToolUseId === toolUseId && item.status !== "cancelled");
    if (!wait) return null;
    const execution = await this.deps.store.getExecution(run.session.tenantId, wait.executionId);
    if (!execution || !isTerminalExecution(execution)) return null;
    const stored = await this.deps.store.consumeResult(wait.executionId,
      this.caller(run, toolUseId), run.fence, {
        type: event.type, data: { ...event.data as object, turnId: run.turnId },
        sessionThreadId: "sthr_primary", apiKeyId: run.apiKeyId,
        idempotencyKey: `pending:${run.fence.eventId}:delegation_result:${toolUseId}`,
      });
    if (!run.signal.aborted && !(await this.deps.store.listWaits(run.session.id, run.fence.eventId))
      .some((item) => item.status === "waiting")) await this.recordStatus(run, "running", toolUseId);
    return stored;
  }

  steering(run: DelegationRun, execution: DelegationExecution): AdapterExecution["steering"] {
    const offered = new Set<string>();
    return {
      takePending: async () => {
        await this.assertOwner(run);
        const commands = await this.deps.store.listCommands(execution.id);
        const instructions: Array<{ id: string; message: string }> = [];
        for (const command of commands) {
          if (command.kind !== "steer" || command.status !== "accepted" || offered.has(command.id)) continue;
          await this.deps.store.applyCommand(command.id, run.fence, {
            type: "subagent.instruction",
            data: { id: command.id, instructionId: command.id, source: "delegation_instruction", commandId: command.id,
              executionId: execution.id, turnId: run.turnId,
              content: [{ type: "text", text: command.message }] },
            sessionThreadId: "sthr_primary", idempotencyKey: `delegation_instruction:${command.id}`,
          });
          offered.add(command.id);
          instructions.push({ id: command.id, message: command.message });
        }
        return instructions;
      },
      // Durable injection is the acknowledgement, not an assertion that the
      // model has understood the instruction. Restart reads that same history.
      applied: async () => {},
    };
  }

  async interruptChildren(session: Session, turnId: string, fence: PendingEventFence): Promise<void> {
    const executions = await this.deps.store.list(session.tenantId, session.id);
    await this.deps.store.cancelWaits(session.id, turnId, fence);
    for (const execution of executions) {
      if (execution.callerTurnId !== turnId || execution.mode !== "sync" || isTerminalExecution(execution)) continue;
      await this.deps.store.command({
        tenantId: session.tenantId, callerSessionId: session.id,
        callerTurnId: turnId, callerToolUseId: `interrupt_${execution.id}`,
        childId: execution.childId, executionId: execution.id,
        kind: "interrupt", message: "The originating synchronous parent Turn was interrupted",
      }, fence);
      // A queued child needs the wake to start; a running one sees the
      // command when its owner checks, at once on the hint.
      this.deps.wake(execution.childId);
      this.deps.check(execution.childId);
    }
  }
}

export function executionResult(execution: DelegationExecution): Record<string, unknown> {
  return {
    childId: execution.childId, executionId: execution.id,
    mode: execution.mode, runInBackground: execution.mode === "async",
    status: execution.status, turnId: execution.turnId,
    budget: { maxModelSteps: execution.maxSteps }, result: execution.result,
    trace: { sessionId: execution.childId, turnId: execution.turnId },
  };
}
/** A delegation tool's value as its result, the way the Pi tool returns it. */
function toolResult(value: unknown): RepairResult {
  return { content: [{ type: "text", text: JSON.stringify(value) ?? "null" }], isError: false };
}
function executionResultIsError(result: Record<string, unknown>): boolean {
  return result.status !== "completed";
}

/** Only what a recovered wait needs to resume the same Turn configuration. */
function waitConfig(run: DelegationRun): DelegationWaitConfig {
  const { model, thinking } = run.effectiveConfig ?? {};
  return { ...(typeof model === "string" ? { model } : {}), ...(typeof thinking === "string" ? { thinking } : {}) };
}

export function outcomeFromEvents(execution: DelegationExecution, events: StoredEvent[], interrupted = false): DelegationOutcome {
  events = events.flatMap(event => presentEvent(event));
  const error = [...events].reverse().find((event) => event.type === "session.error");
  const errorData = error?.data as { error?: { code?: string; message?: string } } | undefined;
  const messages = events.filter((event) => event.type === "agent.message");
  const last = messages.at(-1)?.data as { content?: Array<{ type: string; text?: string }>; stopReason?: string } | undefined;
  const modelFailed = last?.stopReason === "error" || last?.stopReason === "aborted";
  const status = interrupted ? "interrupted"
    : errorData?.error?.code?.includes("budget") ? "budget_exhausted"
    : errorData?.error?.code?.includes("recovery") ? "recovery_required"
    : error || modelFailed ? "failed" : "completed";
  return {
    status, reason: interrupted ? "Interrupted by request" : errorData?.error?.message ??
      (modelFailed ? "The final model request failed" : "Execution completed; saved artifacts have not been independently verified"),
    // Commentary before a failed prompt is not a successful final answer.
    output: status === "completed" ? (last?.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n") : "",
    trace: { sessionId: execution.childId, turnId: execution.turnId },
  };
}

/**
 * A fresh capability per Turn; stale owners cannot start new Sandbox work.
 * The fence only refuses to start commands, it never cancels a running one:
 * stopping a tool is its owner's decision, sent through the tool's own
 * protocol (Pi asks its wrapper to abort with SIGTERM). Killing the command
 * would stop only the wrapper and leave Pi's bash process group running.
 */
export function fencedExecutor(executor: ToolExecutor, assertOwner: () => Promise<void>): ToolExecutor {
  const fs = executor.fileSystem;
  const guardedFs = fs && Object.fromEntries(Object.keys(fs).map((key) => [key, async (...args: unknown[]) => {
    await assertOwner();
    return (fs[key as keyof ToolFileSystem] as (...args: unknown[]) => unknown)(...args);
  }])) as unknown as ToolFileSystem | undefined;
  return {
    fileSystem: guardedFs,
    async *exec(command, options) {
      await assertOwner();
      yield* executor.exec(command, options);
    },
    readFile: async (path) => { await assertOwner(); return executor.readFile(path); },
    writeFile: async (path, content) => { await assertOwner(); return executor.writeFile(path, content); },
    list: async (path) => { await assertOwner(); return executor.list(path); },
  };
}

/** Ends one pause of a wait on a check hint, its fallback poll, or the Turn's abort. */
class WaitWakeup {
  private notified = false;
  private wake?: () => void;

  notify(): void {
    this.notified = true;
    this.wake?.();
  }

  async next(ms: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!this.notified) await new Promise<void>((resolve, reject) => {
      const settle = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.wake = undefined;
      };
      const timer = setTimeout(() => { settle(); resolve(); }, ms);
      const abort = () => { settle(); reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      this.wake = () => { settle(); resolve(); };
    });
    this.notified = false;
  }
}
