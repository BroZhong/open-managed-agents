import { nanoid } from "nanoid";
import type { DelegationStore, DelegationExecution, DelegationAcceptInput, DelegationCaller, DelegationCommand, DelegationOutcome, DelegationWait, ResourceUseLease } from "./interfaces/delegation-store.js";
import type { SessionStore } from "./interfaces/session-store.js";
import type { PendingEventStore, PendingEventFence } from "./interfaces/pending-event-store.js";
import type { EventLogStoreAppendInput } from "./interfaces/event-log-store.js";
import type { StoredEvent } from "./types.js";
import { PendingEventClaimLostError } from "./errors.js";

export type DelegationTable = "executions" | "waits" | "commands" | "resource_uses";
export type DelegationRecord = DelegationExecution | DelegationWait | DelegationCommand | ResourceUseLease;
/** Internal transaction seam shared by production SQL and the development stores. */
export interface DelegationTransaction {
  sessions: Pick<SessionStore, "create" | "getById">;
  pending: PendingEventStore;
  read<T extends DelegationRecord>(table: DelegationTable, filters?: Record<string, string>): Promise<T[]>;
  put(table: DelegationTable, id: string, value: DelegationRecord): Promise<void>;
  remove(table: DelegationTable, id: string): Promise<void>;
  removePending(sessionId: string, eventId: string, onlyUnclaimed?: boolean): Promise<boolean>;
  append(sessionId: string, input: EventLogStoreAppendInput): Promise<StoredEvent>;
  assertFence(sessionId: string, fence: PendingEventFence): Promise<void>;
  assertWorkspaceNotDeleted(tenantId: string, workspaceId: string): Promise<void>;
}
const terminal = (execution: DelegationExecution) => execution.status !== "queued" && execution.status !== "running";
const identity = (caller: DelegationCaller) => JSON.stringify([caller.tenantId, caller.callerSessionId, caller.callerTurnId, caller.callerToolUseId]);
const callerFilter = (caller: DelegationCaller) => ({ tenantId: caller.tenantId, callerSessionId: caller.callerSessionId, callerTurnId: caller.callerTurnId, callerToolUseId: caller.callerToolUseId });
export abstract class TransactionalDelegationStore implements DelegationStore {
  protected abstract transaction<T>(work: (tx: DelegationTransaction) => Promise<T>): Promise<T>;
  abstract withEnvironmentLock<T>(bindingId: string, work: (sandboxId: string | null) => Promise<{ sandboxId: string | null; value: T }>): Promise<T>;
  private async execution(tx: DelegationTransaction, id: string): Promise<DelegationExecution> {
    const row = (await tx.read<DelegationExecution>("executions", { id }))[0];
    if (!row) throw new Error("Delegation execution not found");
    return row;
  }
  private async accessible(tx: DelegationTransaction, tenantId: string, callerSessionId: string, childId: string): Promise<boolean> {
    const child = await tx.sessions.getById(childId);
    return Boolean(child && child.tenantId === tenantId && child.delegation && (child.delegation.parentSessionId === callerSessionId || childId === callerSessionId));
  }
  protected terminatedExecutionIds(sessionId: string | undefined, limit: number): Promise<string[]> {
    return this.transaction(async (tx) => {
      const ids: string[] = [];
      for (const status of ["queued", "running"]) {
        for (const execution of await tx.read<DelegationExecution>("executions", { status })) {
          if (sessionId && execution.childId !== sessionId && execution.callerSessionId !== sessionId) continue;
          const child = await tx.sessions.getById(execution.childId);
          const parent = await tx.sessions.getById(execution.callerSessionId);
          if (child?.status === "terminated" || parent?.status === "terminated" && execution.mode === "sync" && !execution.parentTerminationRequested) ids.push(execution.id);
          if (ids.length >= limit) return ids;
        }
      }
      return ids;
    });
  }
  protected terminatedParentWaits(sessionId: string | undefined, limit: number): Promise<DelegationWait[]> {
    return this.transaction(async (tx) => {
      const result: DelegationWait[] = [];
      for (const wait of await tx.read<DelegationWait>("waits", { status: "waiting", ...(sessionId ? { callerSessionId: sessionId } : {}) })) {
        if ((await tx.sessions.getById(wait.callerSessionId))?.status === "terminated") result.push(wait);
        if (result.length >= limit) break;
      }
      return result;
    });
  }
  async reconcileTerminatedExecutions(sessionId?: string, limit = 100): Promise<DelegationExecution[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid termination reconciliation batch size");
    const [ids, waits] = await Promise.all([this.terminatedExecutionIds(sessionId, limit), this.terminatedParentWaits(sessionId, limit)]);
    if (!ids.length && !waits.length) return [];
    return this.transaction(async (tx) => {
      for (const candidate of waits) {
        const wait = (await tx.read<DelegationWait>("waits", callerFilter(candidate)))[0];
        if (wait?.status === "waiting" && (await tx.sessions.getById(wait.callerSessionId))?.status === "terminated") {
          wait.status = "cancelled"; await tx.put("waits", identity(wait), wait);
        }
      }
      const reconciled: DelegationExecution[] = [];
      for (const id of ids) {
        const execution = await this.execution(tx, id);
        if (terminal(execution)) continue;
        const child = await tx.sessions.getById(execution.childId);
        const parent = await tx.sessions.getById(execution.callerSessionId);
        if (child?.status === "terminated") {
          if (execution.turnId) await tx.append(execution.childId, { type: "session.turn_aborted",
            data: { turnId: execution.turnId, executionId: execution.id, reason: "session_terminated" },
            sessionThreadId: "sthr_primary", idempotencyKey: `delegation-termination:${execution.id}` });
          await tx.removePending(execution.childId, execution.pendingEventId);
          reconciled.push(await this.finish(tx, execution, { status: "interrupted", reason: "Child Session was terminated; recorded output and saved files are retained", output: "", trace: { sessionId: execution.childId, turnId: execution.turnId } }));
        } else if (parent?.status === "terminated" && execution.mode === "sync" && !execution.parentTerminationRequested) {
          execution.parentTerminationRequested = true;
          if (execution.status === "queued") {
            await tx.removePending(execution.childId, execution.pendingEventId);
            reconciled.push(await this.finish(tx, execution, { status: "interrupted", reason: "Synchronous delegation withdrawn because its parent Session was terminated", output: "", trace: { sessionId: execution.childId } }));
          } else {
            const command: DelegationCommand = { ...callerFilter(execution), callerToolUseId: `terminate-parent:${execution.id}`,
              id: `terminate-parent:${execution.id}`, executionId: execution.id, childId: execution.childId, kind: "interrupt",
              message: "The parent Session owning this synchronous execution was terminated", status: "accepted",
              targetTurnId: execution.turnId, targetGeneration: execution.generation, createdAt: new Date().toISOString() };
            await tx.put("commands", command.id, command);
            execution.updatedAt = new Date().toISOString();
            await tx.put("executions", execution.id, execution);
            reconciled.push(execution);
          }
        }
      }
      return reconciled;
    });
  }
  async accept(input: DelegationAcceptInput, fence: PendingEventFence): Promise<DelegationExecution> {
    if (!input.prompt.trim() || !Number.isInteger(input.maxSteps) || input.maxSteps < 1 || input.maxSteps > 1000) throw new Error("Invalid delegation prompt or step budget");
    if (input.mode !== "sync" && input.mode !== "async") throw new Error("Invalid delegation mode");
    if (typeof input.parentModel !== "string" || !input.parentModel.trim()) throw new Error("Resolved parent model is required");
    return this.transaction(async (tx) => {
      await tx.assertFence(input.callerSessionId, fence);
      const parent = await tx.sessions.getById(input.callerSessionId);
      if (!parent || parent.tenantId !== input.tenantId || parent.status === "terminated") throw new Error("Parent Session unavailable");
      if (parent.delegation) throw new Error("Nested delegation is not supported");
      const existing = (await tx.read<DelegationExecution>("executions", callerFilter(input)))[0];
      if (existing) return existing;
      let child;
      if (input.resume) {
        if (!await this.accessible(tx, input.tenantId, input.callerSessionId, input.resume)) throw new Error("Child Session not found or not accessible");
        child = await tx.sessions.getById(input.resume);
        if (!child || child.status === "terminated") throw new Error("Child Session terminated; cannot resume");
      } else {
        await tx.assertWorkspaceNotDeleted(parent.tenantId, parent.workspaceId);
        child = await tx.sessions.create({ tenantId: parent.tenantId, agentId: parent.agentId, agent: { ...parent.agent, model: input.parentModel }, workspaceId: parent.workspaceId,
          delegation: { parentSessionId: parent.id, parentTurnId: input.callerTurnId, parentToolUseId: input.callerToolUseId, sandboxSessionId: input.sandboxSessionId } });
      }
      const previous = await tx.read<DelegationExecution>("executions", { childId: child.id });
      const sequence = previous.reduce((maximum, execution) => Math.max(maximum, execution.sequence ?? 0), 0) + 1;
      const id = `deleg_${nanoid()}`;
      const pending = await tx.pending.enqueue(child.id, { type: "delegation.input", data: { content: [{ type: "text", text: input.prompt }], source: "delegation", executionId: id }, sessionThreadId: "sthr_primary", apiKeyId: input.apiKeyId });
      const now = new Date().toISOString();
      const execution: DelegationExecution = { ...callerFilter(input), id, sequence, childId: child.id, pendingEventId: pending.id, mode: input.mode, status: "queued", prompt: input.prompt, apiKeyId: input.apiKeyId, model: input.parentModel, modelSource: "parent", thinking: input.thinking, maxSteps: input.maxSteps, createdAt: now, updatedAt: now };
      await tx.put("executions", id, execution);
      if (input.mode === "sync") {
        const wait: DelegationWait = { ...callerFilter(input), executionId: id, parentPendingEventId: fence.eventId, checkpoint: input.checkpoint ?? {}, status: "waiting" };
        await tx.put("waits", identity(wait), wait);
      }
      return execution;
    });
  }
  getChild(tenantId: string, childId: string) { return this.transaction(async (tx) => { const child = await tx.sessions.getById(childId); return child?.tenantId === tenantId && child.delegation ? child : null; }); }
  getExecution(tenantId: string, executionId: string) { return this.transaction(async (tx) => (await tx.read<DelegationExecution>("executions", { tenantId, id: executionId }))[0] ?? null); }
  listExecutions(tenantId: string, opts: { callerSessionId?: string; callerTurnId?: string; callerToolUseId?: string; childId?: string; limit?: number; afterId?: string }) {
    return this.transaction(async (tx) => {
      const filters: Record<string, string> = { tenantId };
      for (const field of ["callerSessionId", "callerTurnId", "callerToolUseId", "childId"] as const) if (opts[field]) filters[field] = opts[field];
      const rows = await tx.read<DelegationExecution>("executions", filters);
      rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      const offset = opts.afterId ? rows.findIndex((row) => row.id === opts.afterId) + 1 : 0;
      return rows.slice(offset, offset + Math.min(Math.max(opts.limit ?? 100, 1), 500));
    });
  }
  get(tenantId: string, callerSessionId: string, childId: string, executionId?: string) {
    return this.transaction(async (tx) => {
      if (!await this.accessible(tx, tenantId, callerSessionId, childId)) return null;
      const rows = await tx.read<DelegationExecution>("executions", { tenantId, childId, ...(executionId ? { id: executionId } : {}) });
      return rows.sort((a, b) => b.sequence - a.sequence)[0] ?? null;
    });
  }
  getByPendingEventId(pendingEventId: string) { return this.transaction(async (tx) => (await tx.read<DelegationExecution>("executions", { pendingEventId }))[0] ?? null); }
  list(tenantId: string, callerSessionId: string) { return this.listExecutions(tenantId, { callerSessionId, limit: 500 }); }
  startExecution(executionId: string, fence: PendingEventFence, turnId: string, effectiveConfig: Record<string, unknown>, maxConcurrent: number) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new Error("Invalid delegation concurrency quota");
    return this.transaction(async (tx) => {
      const execution = await this.execution(tx, executionId);
      await tx.assertFence(execution.childId, fence);
      if (fence.eventId !== execution.pendingEventId) throw new Error("Delegation input fence mismatch");
      if (terminal(execution)) return execution;
      if (execution.status === "running") {
        if (execution.ownerId === fence.ownerId && execution.generation === fence.generation) return execution;
        // An expired owner may have performed external effects. Never replay its prompt.
        return this.finish(tx, execution, { status: "recovery_required", reason: "Execution lease expired; external tool effects may be uncertain. Inspect history and resume explicitly.", output: "", trace: { sessionId: execution.childId, turnId: execution.turnId } });
      }
      const siblings = await tx.read<DelegationExecution>("executions", { tenantId: execution.tenantId, callerSessionId: execution.callerSessionId, status: "running" });
      let active = 0;
      for (const sibling of siblings) {
        const owns = sibling.ownerId && sibling.generation !== undefined && await tx.pending.ownsClaim?.(sibling.childId, sibling.pendingEventId, { ownerId: sibling.ownerId, generation: sibling.generation });
        if (owns) active++;
        else await this.finish(tx, sibling, { status: "recovery_required", reason: "Execution owner lease expired; inspect uncertain effects before resume.", output: "", trace: { sessionId: sibling.childId, turnId: sibling.turnId } });
      }
      if (active >= maxConcurrent) return null;
      const child = await tx.sessions.getById(execution.childId);
      if (!child?.delegation) throw new Error("Child Session environment binding missing");
      await tx.put("resource_uses", fence.eventId, { sessionId: execution.childId,
        sandboxSessionId: child.delegation.sandboxSessionId, pendingEventId: fence.eventId,
        ownerId: fence.ownerId, generation: fence.generation });
      const { maxModelSteps: _legacySteps, ...configuration } = effectiveConfig;
      Object.assign(execution, { status: "running", turnId, effectiveConfig: { ...configuration, maxSteps: execution.maxSteps }, ownerId: fence.ownerId, generation: fence.generation, updatedAt: new Date().toISOString() });
      await tx.put("executions", execution.id, execution);
      return execution;
    });
  }
  updateEffectiveConfig(executionId: string, fence: PendingEventFence, config: Record<string, unknown>) {
    return this.transaction(async (tx) => {
      const execution = await this.execution(tx, executionId);
      await tx.assertFence(execution.childId, fence);
      if (execution.status !== "running" || fence.eventId !== execution.pendingEventId ||
        execution.ownerId !== fence.ownerId || execution.generation !== fence.generation) {
        throw new Error("Delegation configuration update requires the current running execution owner");
      }
      const { maxModelSteps: _legacySteps, ...configuration } = { ...execution.effectiveConfig, ...config };
      execution.effectiveConfig = { ...configuration, maxSteps: execution.maxSteps };
      execution.updatedAt = new Date().toISOString();
      await tx.put("executions", execution.id, execution);
    });
  }
  private async finish(tx: DelegationTransaction, execution: DelegationExecution, outcome: DelegationOutcome) {
    if (terminal(execution)) return execution;
    Object.assign(execution, { status: outcome.status, result: outcome, updatedAt: new Date().toISOString() });
    const resultData = { source: "subagent_result", executionId: execution.id, childId: execution.childId, childTurnId: execution.turnId, callerTurnId: execution.callerTurnId, callerToolUseId: execution.callerToolUseId, mode: execution.mode, result: outcome };
    // Lock parent before its event counter; ordinary parent appends use this order too.
    const parent = await tx.sessions.getById(execution.callerSessionId);
    const notification = await tx.append(execution.callerSessionId, { type: "subagent.result", data: resultData, sessionThreadId: "sthr_primary", idempotencyKey: `delegation-result:${execution.id}` });
    execution.notificationEventSeq = notification.seq;
    if (execution.mode === "async" && !execution.consumedAt && parent && parent.status !== "terminated") {
      const pending = await tx.pending.enqueue(parent.id, { type: "subagent.result", data: { ...resultData, notificationSeq: notification.seq }, sessionThreadId: "sthr_primary", apiKeyId: execution.apiKeyId });
      execution.notificationPendingEventId = pending.id;
      execution.notificationStatus = "pending";
    }
    execution.notificationStatus ??= "suppressed";
    for (const command of await tx.read<DelegationCommand>("commands", { executionId: execution.id, status: "accepted" })) {
      command.status = "not_applied";
      await tx.put("commands", command.id, command);
    }
    await tx.remove("resource_uses", execution.pendingEventId);
    await tx.put("executions", execution.id, execution);
    return execution;
  }
  finishExecution(executionId: string, fence: PendingEventFence, outcome: DelegationOutcome) {
    return this.transaction(async (tx) => {
      const execution = await this.execution(tx, executionId);
      await tx.assertFence(execution.childId, fence);
      if (fence.eventId !== execution.pendingEventId || (execution.generation !== undefined && execution.generation !== fence.generation)) throw new Error("Delegation generation mismatch");
      return this.finish(tx, execution, outcome);
    });
  }
  saveWait(wait: Omit<DelegationWait, "status">, fence: PendingEventFence) {
    return this.transaction(async (tx) => {
      await tx.assertFence(wait.callerSessionId, fence);
      if (wait.parentPendingEventId !== fence.eventId) throw new Error("Parent pending input mismatch");
      const execution = await this.execution(tx, wait.executionId);
      if (!await this.accessible(tx, wait.tenantId, wait.callerSessionId, execution.childId)) throw new Error("Child Session not accessible");
      const existing = (await tx.read<DelegationWait>("waits", callerFilter(wait)))[0];
      if (existing) return existing;
      const saved: DelegationWait = { ...wait, status: "waiting" };
      await tx.put("waits", identity(wait), saved);
      return saved;
    });
  }
  listWaits(parentSessionId: string, parentPendingEventId: string) { return this.transaction((tx) => tx.read<DelegationWait>("waits", { callerSessionId: parentSessionId, parentPendingEventId })); }
  consumeResult(executionId: string, caller: DelegationCaller, fence: PendingEventFence, event: EventLogStoreAppendInput) {
    return this.transaction(async (tx) => {
      await tx.assertFence(caller.callerSessionId, fence);
      const execution = await this.execution(tx, executionId);
      if (!terminal(execution) || !await this.accessible(tx, caller.tenantId, caller.callerSessionId, execution.childId)) throw new Error("Delegation result unavailable");
      const saved = await tx.append(caller.callerSessionId, { ...event, pendingFence: fence, idempotencyKey: `delegation-tool-result:${identity(caller)}` });
      execution.consumedAt ??= new Date().toISOString();
      execution.notificationStatus = "consumed";
      if (execution.notificationPendingEventId) await tx.removePending(caller.callerSessionId, execution.notificationPendingEventId, true);
      await tx.put("executions", execution.id, execution);
      for (const wait of await tx.read<DelegationWait>("waits", callerFilter(caller))) {
        wait.status = "consumed"; wait.toolResultSeq = saved.seq;
        await tx.put("waits", identity(wait), wait);
      }
      return saved;
    });
  }
  markNotificationProcessed(executionId: string, parentFence: PendingEventFence) {
    return this.transaction(async (tx) => {
      const execution = await this.execution(tx, executionId);
      await tx.assertFence(execution.callerSessionId, parentFence);
      if (execution.notificationPendingEventId !== parentFence.eventId) throw new Error("Notification pending input mismatch");
      if (execution.notificationStatus !== "consumed") execution.notificationStatus = "processed";
      await tx.put("executions", execution.id, execution);
    });
  }
  cancelWaits(parentSessionId: string, parentTurnId: string, fence?: PendingEventFence) {
    return this.transaction(async (tx) => {
      if (fence) await tx.assertFence(parentSessionId, fence);
      const waits = await tx.read<DelegationWait>("waits", { callerSessionId: parentSessionId, callerTurnId: parentTurnId, status: "waiting" });
      for (const wait of waits) { wait.status = "cancelled"; await tx.put("waits", identity(wait), wait); }
    });
  }
  command(input: DelegationCaller & { childId: string; executionId?: string; kind: "steer" | "interrupt"; message: string }, callerFence?: PendingEventFence) {
    return this.transaction(async (tx) => {
      if (callerFence) await tx.assertFence(input.callerSessionId, callerFence);
      if (!await this.accessible(tx, input.tenantId, input.callerSessionId, input.childId)) throw new Error("Child Session not accessible");
      const existing = (await tx.read<DelegationCommand>("commands", callerFilter(input)))[0];
      if (existing) return existing;
      const candidates = await tx.read<DelegationExecution>("executions", { tenantId: input.tenantId, childId: input.childId, ...(input.executionId ? { id: input.executionId } : {}) });
      // Direct Interrupt always selects a running Turn, never a later queued resume.
      const execution = input.executionId ? candidates[0] : candidates.find((row) => row.status === "running") ?? candidates.filter((row) => row.status === "queued").sort((a, b) => a.sequence - b.sequence)[0] ?? candidates.sort((a, b) => b.sequence - a.sequence)[0];
      if (!execution) throw new Error("Delegation execution not found");
      const command: DelegationCommand = { ...callerFilter(input), id: `dcmd_${nanoid()}`, executionId: execution.id, childId: execution.childId, kind: input.kind, message: input.message, status: terminal(execution) ? "not_applied" : "accepted", targetTurnId: execution.turnId, targetGeneration: execution.generation, createdAt: new Date().toISOString() };
      if (input.kind === "interrupt" && execution.status === "queued") {
        if (input.callerSessionId === input.childId) command.status = "not_applied";
        else {
          await tx.removePending(execution.childId, execution.pendingEventId);
          await this.finish(tx, execution, { status: "interrupted", reason: "Delegation input withdrawn by parent Interrupt before execution", output: "", trace: { sessionId: execution.childId } });
          command.status = "applied";
        }
      }
      await tx.put("commands", command.id, command);
      return command;
    });
  }
  listCommands(executionId: string) { return this.transaction(async (tx) => (await tx.read<DelegationCommand>("commands", { executionId })).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))); }
  applyCommand(commandId: string, fence: PendingEventFence, event: EventLogStoreAppendInput) {
    return this.transaction(async (tx) => {
      const command = (await tx.read<DelegationCommand>("commands", { id: commandId }))[0];
      if (!command) throw new Error("Delegation command not found");
      const execution = await this.execution(tx, command.executionId);
      await tx.assertFence(command.childId, fence);
      if (fence.eventId !== execution.pendingEventId || execution.generation !== fence.generation) throw new Error("Delegation command generation mismatch");
      if (command.status !== "accepted") return command;
      if (terminal(execution)) command.status = "not_applied";
      else {
        const saved = await tx.append(command.childId, { ...event, pendingFence: fence, idempotencyKey: `delegation-command:${command.id}` });
        command.status = "applied"; command.appliedEventSeq = saved.seq;
      }
      await tx.put("commands", command.id, command);
      return command;
    });
  }
  acquireResourceUse(sessionId: string, sandboxSessionId: string, fence: PendingEventFence) {
    return this.transaction(async (tx) => {
      await tx.assertFence(sessionId, fence);
      const lease: ResourceUseLease = { sessionId, sandboxSessionId, pendingEventId: fence.eventId, ownerId: fence.ownerId, generation: fence.generation };
      await tx.put("resource_uses", fence.eventId, lease);
      return lease;
    });
  }
  releaseResourceUse(sessionId: string, fence: PendingEventFence) {
    return this.transaction(async (tx) => {
      const lease = (await tx.read<ResourceUseLease>("resource_uses", { sessionId, pendingEventId: fence.eventId }))[0];
      if (lease?.ownerId === fence.ownerId && lease.generation === fence.generation) await tx.remove("resource_uses", fence.eventId);
    });
  }
  hasResourceUsers(sandboxSessionId: string) {
    return this.transaction(async (tx) => {
      for (const use of await tx.read<ResourceUseLease>("resource_uses", { sandboxSessionId })) {
        if (await tx.pending.ownsClaim?.(use.sessionId, use.pendingEventId, use)) return true;
        await tx.remove("resource_uses", use.pendingEventId);
      }
      // A queued accepted child still depends on the same environment (e.g.
      // parent-created /tmp inputs), even before it can obtain an execution slot.
      for (const execution of await tx.read<DelegationExecution>("executions", { status: "queued" })) {
        const child = await tx.sessions.getById(execution.childId);
        if (child?.status !== "terminated" && child?.delegation?.sandboxSessionId === sandboxSessionId) return true;
      }
      return false;
    });
  }
}
export function delegationFenceLost(sessionId: string, fence: PendingEventFence): never { throw new PendingEventClaimLostError(sessionId, fence.eventId, fence.ownerId, fence.generation); }
