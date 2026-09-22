import type {
  DelegationCaller, DelegationExecution, DelegationOutcome, DelegationStore,
  DelegationWait, EventLogStore, PendingEventFence, PendingEventStore, Session,
  SessionStore, StoredEvent,
} from "@oma-server/store";
import { PendingEventClaimLostError, presentContextData, presentEvent } from "@oma-server/store";
import type {
  AdapterExecution, AgentToolResultEvent, HostSubagentCapability, SessionEvent,
  SubagentCallContext, ToolExecutor, ToolFileSystem,
} from "@open-managed-agents/adapter-core";

export interface DelegationRun {
  session: Session;
  turnId: string;
  fence: PendingEventFence;
  signal: AbortSignal;
  apiKeyId?: string;
  effectiveConfig?: Record<string, unknown>;
}

interface CoordinatorDeps {
  store: DelegationStore;
  pending: PendingEventStore;
  sessions: SessionStore;
  events: EventLogStore;
  wake(sessionId: string): void;
  publish(event: StoredEvent): void;
  maxSteps: number;
  pollMs?: number;
}

export const isTerminalExecution = (execution: DelegationExecution): boolean =>
  execution.status !== "queued" && execution.status !== "running";

/** Coordination only; every child is executed by the ordinary Session Router. */
export class DelegationCoordinator {
  constructor(private readonly deps: CoordinatorDeps) {}

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
    if (this.deps.pending.ownsClaim && !await this.deps.pending.ownsClaim(
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
          checkpoint: { events: context.checkpoint, config: run.effectiveConfig },
        }, run.fence);
        // Persist the wait before waking the child. The checkpoint closes the
        // gap between the SDK calling a tool and its Event reaching the Router.
        if (execution.mode === "sync") await this.saveWait(run, execution, context);
        this.deps.wake(execution.childId);
        return execution.mode === "sync"
          ? this.waitForResult(run, execution)
          : this.readResult(execution);
      },
      getResult: async (input, context) => {
        await this.assertOwner(run);
        const priorWait = (await this.deps.store.listWaits(run.session.id, run.fence.eventId, { checkpoint: "reference" }))
          .find((wait) => wait.callerToolUseId === context.toolUseId);
        const execution = await this.deps.store.get(
          run.session.tenantId, run.session.id, input.childId, priorWait?.executionId ?? input.executionId,
        );
        if (!execution) throw new Error("Child Session or execution not found; legacy plugin child IDs cannot be resumed");
        // A terminal query also records its consumption intent. Only the
        // eventual durable tool result consumes/suppresses its async delivery.
        if (input.wait || isTerminalExecution(execution)) await this.saveWait(run, execution, context);
        return input.wait ? this.waitForResult(run, execution) : this.readResult(execution);
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

  private async saveWait(run: DelegationRun, execution: DelegationExecution, context: SubagentCallContext): Promise<void> {
    await this.deps.store.saveWait({
      ...this.caller(run, context.toolUseId), executionId: execution.id,
      parentPendingEventId: run.fence.eventId,
      checkpoint: { events: context.checkpoint, config: run.effectiveConfig },
    }, run.fence);
  }

  async waitForResult(run: DelegationRun, execution: DelegationExecution): Promise<Record<string, unknown>> {
    await this.setWaiting(run, true);
    try {
      for (;;) {
        await this.assertOwner(run);
        const current = await this.deps.store.get(
          run.session.tenantId, run.session.id, execution.childId, execution.id,
        );
        if (!current) throw new Error("Delegation execution disappeared");
        if (isTerminalExecution(current)) return this.readResult(current);
        this.deps.wake(current.childId);
        await delay(this.deps.pollMs ?? 200, run.signal);
      }
    } finally {
      if (!run.signal.aborted && !(await this.deps.store.listWaits(run.session.id, run.fence.eventId, { checkpoint: "reference" }))
        .some((wait) => wait.status === "waiting")) await this.setWaiting(run, false);
    }
  }

  private async readResult(execution: DelegationExecution): Promise<Record<string, unknown>> {
    const commands = (await this.deps.store.listCommands(execution.id)).map((command) => ({
      id: command.id, kind: command.kind, message: command.message, status: command.status,
      createdAt: command.createdAt, appliedEventSeq: command.appliedEventSeq,
    }));
    return { ...executionResult(execution), commands };
  }

  private async setWaiting(run: DelegationRun, waiting: boolean): Promise<void> {
    await this.assertOwner(run);
    await this.deps.sessions.updateStatusIfClaimed?.(run.session.id, waiting ? "waiting" : "running", run.fence);
    const event = await this.deps.events.append(run.session.id, {
      type: waiting ? "session.status_waiting" : "session.status_running",
      data: { turnId: run.turnId }, sessionThreadId: "sthr_primary", pendingFence: run.fence,
    });
    this.deps.publish(event);
  }

  /** Complete the exact original tool, under the new owner after a restart. */
  async recoverWaits(run: DelegationRun, waits: DelegationWait[]): Promise<void> {
    for (const wait of waits) {
      if (wait.status === "cancelled") continue;
      const snapshot = wait.checkpoint.events;
      if (Array.isArray(snapshot)) {
        for (const event of snapshot as SessionEvent[]) {
          // The checkpoint consists solely of complete SDK events. Lifecycle
          // markers are owned by Router; user input is already promoted.
          if (!event.id || !event.type.startsWith("agent.") && !event.type.startsWith("span.")) continue;
          // Tool results have a separate atomic consumption key. Restoring an
          // SDK snapshot must not append the same result under an event-ID key.
          if (event.type === "agent.tool_result" && waits.some((item) => item.callerToolUseId === event.toolUseId)) continue;
          // Native results use the same atomic consumption identity on replay;
          // an event-ID append would duplicate an already consumed native row.
          if (event.type === "agent.context_entry" && await this.persistToolResult(run, event)) continue;
          const stored = await this.deps.events.append(run.session.id, {
            type: event.type, data: { ...event, turnId: run.turnId },
            sessionThreadId: "sthr_primary", apiKeyId: run.apiKeyId,
            idempotencyKey: `pending:${run.fence.eventId}:event:${event.id}`,
            pendingFence: run.fence,
          });
          this.deps.publish(stored);
        }
      }
      if (wait.status === "consumed") continue;
      const execution = await this.deps.store.getExecution(run.session.tenantId, wait.executionId);
      if (!execution) throw new Error("Waiting execution not found");
      const result = await this.waitForResult(run, execution);
      const event: AgentToolResultEvent = {
        id: `delegation_result_${wait.executionId}_${wait.callerToolUseId}`,
        timestamp: new Date().toISOString(), type: "agent.tool_result", toolUseId: wait.callerToolUseId,
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError: executionResultIsError(result),
      };
      await this.persistToolResult(run, event);
    }
  }

  async persistToolResult(run: DelegationRun, event: SessionEvent): Promise<StoredEvent | null> {
    const result = event.type === "agent.tool_result" ? event
      : presentContextData(event.type, event).find(item => item.type === "agent.tool_result")?.data;
    if (!result) return null;
    const toolUseId = result.toolUseId as string;
    const wait = (await this.deps.store.listWaits(run.session.id, run.fence.eventId, { checkpoint: "reference" }))
      .find((item) => item.callerToolUseId === toolUseId && item.status !== "cancelled");
    if (!wait) return null;
    const execution = await this.deps.store.getExecution(run.session.tenantId, wait.executionId);
    if (!execution || !isTerminalExecution(execution)) return null;
    const stored = await this.deps.store.consumeResult(wait.executionId,
      this.caller(run, toolUseId), run.fence, {
        type: event.type, data: { ...event, turnId: run.turnId },
        sessionThreadId: "sthr_primary", apiKeyId: run.apiKeyId,
        idempotencyKey: `pending:${run.fence.eventId}:delegation_result:${toolUseId}`,
      });
    this.deps.publish(stored);
    if (!run.signal.aborted && !(await this.deps.store.listWaits(run.session.id, run.fence.eventId, { checkpoint: "reference" }))
      .some((item) => item.status === "waiting")) await this.setWaiting(run, false);
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
      this.deps.wake(execution.childId);
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
function executionResultIsError(result: Record<string, unknown>): boolean {
  return result.status !== "completed";
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

/** A fresh capability per Turn; stale owners cannot start new Sandbox work. */
export function fencedExecutor(executor: ToolExecutor, assertOwner: () => Promise<void>, signal: AbortSignal): ToolExecutor {
  const fs = executor.fileSystem;
  const guardedFs = fs && Object.fromEntries(Object.keys(fs).map((key) => [key, async (...args: unknown[]) => {
    await assertOwner();
    return (fs[key as keyof ToolFileSystem] as (...args: unknown[]) => unknown)(...args);
  }])) as unknown as ToolFileSystem | undefined;
  return {
    fileSystem: guardedFs,
    async *exec(command, options) {
      await assertOwner();
      yield* executor.exec(command, { ...options, signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal });
    },
    readFile: async (path) => { await assertOwner(); return executor.readFile(path); },
    writeFile: async (path, content) => { await assertOwner(); return executor.writeFile(path, content); },
    list: async (path) => { await assertOwner(); return executor.list(path); },
  };
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
  });
}
