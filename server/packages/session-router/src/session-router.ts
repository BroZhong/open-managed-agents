import type {
  EventLogStore,
  PendingEventStore,
  PendingEventClaim,
  PendingEventFence,
  StoredEvent,
  Agent,
  AgentFileStore,
  AgentStore,
  Session,
  SkillStore,
  SkillArtifactStore,
  DelegationStore,
  DelegationExecution,
  SandboxActivity,
} from "@oma-server/store";
import { PendingEventClaimLostError, workspaceObjectPrefix, validateArtifactPath, presentEvent } from "@oma-server/store";
import { ManagedMcpResolutionError, resolveManagedMcpServers } from "@oma-server/mcp-catalog";
import { randomUUID } from "node:crypto";
import type { SessionStore } from "@oma-server/store";
import type { EventStreamHub } from "@oma-server/event-log";
import type { TurnStreamStore } from "@oma-server/redis";
import type {
  EnvSpec,
  SandboxManager,
  SandboxSession,
  WorkspaceMountSpec,
  ReadonlyProjection,
} from "@oma-server/sandbox";
import { WORKSPACE_ENV, WORKSPACE_INSTRUCTIONS } from "./workspace-environment.js";
import type {
  Adapter,
  AdapterInput,
  AdapterRunResult,
  SessionEvent,
  StreamEvent,
  ContentBlock,
  ToolExecutor,
  TurnJournalPort,
  UserMessage,
  SkillDescriptor,
} from "@open-managed-agents/adapter-core";
import { DelegationCoordinator, fencedExecutor, outcomeFromEvents, isTerminalExecution, type DelegationRun } from "./delegation-coordinator.js";
import { TurnJournal, type JournalEvent } from "./turn-journal.js";

/**
 * The fixed assembly order for an Agent's Files into `appendSystemPrompt`.
 * Missing files are skipped. See issue #48.
 */
const AGENT_FILE_ORDER = ["IDENTITY", "SOUL", "USER", "MEMORY"] as const;

const SESSION_INTERRUPTED_MESSAGE = "Session interrupted";
const SESSION_TERMINATED_MESSAGE = "Session terminated";
const DEFAULT_INTERRUPTED_ADAPTER_DRAIN_TIMEOUT_MS = 2_000;

/** How an Adapter's run() settled. */
type AdapterOutcome = { result: AdapterRunResult } | { error: unknown };

interface EquippedSkill {
  id: string;
  descriptor: SkillDescriptor;
}

/** What the ports of a Turn attempt's journal learn while the attempt is prepared. */
interface AttemptWrites {
  /** The prepared Turn's delegation run; tool results consume its waits. */
  delegationRun?: DelegationRun;
  /** Durable form and idempotency key of an Adapter event, set before the Adapter runs. */
  fromAdapter?(event: Exclude<SessionEvent, StreamEvent>): { event: JournalEvent; key: string };
}

interface ActiveSessionRun {
  controller: AbortController;
  /** Stops the running Turn attempt, if any, without terminal events. */
  stopAttempt?: (reason: unknown) => void;
}

class PendingLeaseLostError extends Error {
  constructor() {
    super("Pending event lease lost");
    this.name = "PendingLeaseLostError";
  }
}

export interface SessionRouterDeps {
  wakeSession?: (sessionId: string) => void;
  delegationStore?: DelegationStore;
  maxConcurrentSubagents?: number;
  maxSubagentModelSteps?: number;
  eventLogStore: EventLogStore;
  pendingEventStore: PendingEventStore;
  sessionStore: SessionStore;
  eventStreamHub: EventStreamHub;
  /** The Adapter for an Agent runtime, or undefined when this Runner cannot execute it. */
  resolveAdapter: (runtime: string) => Adapter | undefined;
  /**
   * The single owner of sandbox lifecycle (ADR-0005 §1, design doc §2/§6).
   * When present and the agent is sandboxed, the router `open`s exactly one
   * {@link SandboxSession} per Session (cheap — lazy, no sandbox is started
   * until the first tool call), injects it as the per-run {@link ToolExecutor},
   * checks its Workspace availability at each Turn end, and `dispose`s it — destroying the
   * sandbox — at session end. Absent ⇒ a sandboxed agent fails loud (see
   * {@link isSandboxedButUnprovisionable}); an opted-out agent runs with no
   * injected executor (its own tool execution, no sandbox).
   *
   * Replaces the old `toolExecutorFactory` + per-session executor Map: the
   * SandboxSession owns its own lifecycle and self-heal, so the router keeps
   * only a lookup Map (`sessions`) and never a lifecycle registry.
   */
  sandboxManager?: SandboxManager;
  /** Deployment-owned mount identity; the Host derives its prefix from Session ownership. */
  workspaceMount?: Omit<WorkspaceMountSpec, "prefix">;
  /**
   * Per-Agent editable Files (IDENTITY/SOUL/USER/MEMORY). When present, the
   * router assembles the running Agent's Files into `appendSystemPrompt` in a
   * fixed order before each turn (issue #48). Absent ⇒ no instructions
   * assembled (no regression). See ADR-0002: the Host owns *what* to inject.
   */
  agentFileStore?: AgentFileStore;
  /**
   * The tenant's Agent config store. When present, the router resolves the
   * running Agent's **current mutable config** per turn, rather than using the
   * copy snapshotted onto the Session at creation. This makes model/system/tool/
   * runtime and equipped-Skill edits take effect in existing conversations;
   * the Session snapshot remains the historical fallback if the Agent is gone.
   */
  agentStore?: AgentStore;
  /**
   * Tenant Skill Library metadata + S3 bodies. When both are present, the
   * router selects the Agent's *equipped* Skills that are valid (exist, in this
   * tenant, owned by this Agent when `ownerType==='agent'`, and non-empty) and
   * declares each as a **Read-only Projection** into the sandbox at
   * `/skills/<skill-name>` (ADR-0007). The Skill *content* flows S3→sandbox inside
   * the SandboxManager (via `S3ProvisionSource`) — never through the Host — so
   * the router consults `skillArtifactStore` only to confirm a Skill is
   * non-empty (mirroring the old `materializeSkills`' zero-files skip), not to
   * read bodies. Absent ⇒ no Skills projected.
   *
   * WHY the sandbox and not a Host temp dir (ADR-0005 §4): the Pi adapter runs
   * `noTools: "builtin"` + custom tools, so Pi's prompt tells the model to
   * `read` a Skill's file — and that read is sandbox-mapped. A Skill left on the
   * Host would therefore be unreadable; it MUST be projected into the sandbox.
   */
  skillStore?: SkillStore;
  skillArtifactStore?: SkillArtifactStore;
  /**
   * Transient per-turn delta stream + active-turn map (Redis). When present,
   * token-level deltas are written to `stream:session:{sessionId}:turn:{turnId}` for server-side
   * reconnect backfill and reclaimed (DEL) at turn end; the active-turn map is
   * kept in Redis so multi-instance reconnect stays correct. Deltas are never
   * persisted to PostgreSQL. When absent, deltas are live-only (hub chunks).
   */
  turnStreamStore?: TurnStreamStore;
  /**
   * Deployment-wide default sandbox environment variables, merged into every
   * sandboxed Agent's `EnvSpec.env` (the Agent's own `sandbox.env` wins per key).
   * Used to inject a shared secret a bundled CLI needs — e.g. `VFS_TOKEN` for the
   * `vfs-cli` baked into the custom sandbox image — without requiring every Agent
   * to carry the token in its own config. Sourced from server config (a K8s
   * Secret → env), so the token never lives in code or in the Agent record.
   * Absent ⇒ only the Agent's own `sandbox.env` is used (prior behavior).
   */
  defaultSandboxEnv?: Record<string, string>;
  /** Deployment-managed sandbox variables, explicitly scoped per Agent id. */
  managedSandboxEnvByAgentId?: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  /** Stable, process-unique pending owner. Injectable for deterministic tests. */
  pendingClaimOwnerId?: string;
  /** Pending lease duration; renewed while an Adapter/tool turn is running. */
  pendingClaimLeaseMs?: number;
  /** Heartbeat cadence. Must be shorter than pendingClaimLeaseMs. */
  pendingClaimRenewIntervalMs?: number;
  /** Bounded retry window when another Host currently owns the FIFO head. */
  pendingClaimRetryMinMs?: number;
  pendingClaimRetryMaxMs?: number;
  /**
   * How long an interrupted Adapter's run() may take to settle. The Router
   * then revokes the Adapter's journal entry and closes the Turn: what the
   * Adapter recorded until then is written, anything later is dropped.
   */
  interruptedAdapterDrainTimeoutMs?: number;
  /** Observe background retry failures without creating unhandled rejections. */
  onDrainError?: (failure: PendingRecoveryFailure) => void;
}

export interface PendingRecoverySummary {
  /** Valid Sessions whose retained input was scheduled on their single drainer. */
  recovered: string[];
  /** Missing or terminated Sessions whose unusable queues were cleared. */
  discarded: string[];
  /** Valid Sessions left pending because recovery failed and may be retried. */
  failed: Array<{ sessionId: string; error: unknown }>;
}

export interface PendingRecoveryFailure {
  sessionId: string;
  error: unknown;
}

export class SessionRouter {
  private readonly eventLogStore: EventLogStore;
  private readonly pendingEventStore: PendingEventStore;
  private readonly sessionStore: SessionStore;
  private readonly eventStreamHub: EventStreamHub;
  private readonly resolveAdapter: (runtime: string) => Adapter | undefined;
  private readonly sandboxManager?: SandboxManager;
  private readonly workspaceMount?: Omit<WorkspaceMountSpec, "prefix">;
  private readonly agentFileStore?: AgentFileStore;
  private readonly agentStore?: AgentStore;
  private readonly skillStore?: SkillStore;
  private readonly skillArtifactStore?: SkillArtifactStore;
  private readonly turnStreamStore?: TurnStreamStore;
  private readonly defaultSandboxEnv?: Record<string, string>;
  private readonly managedSandboxEnvByAgentId?: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  private readonly pendingClaimOwnerId: string;
  private readonly pendingClaimLeaseMs: number;
  private readonly pendingClaimRenewIntervalMs: number;
  private readonly pendingClaimRetryMinMs: number;
  private readonly pendingClaimRetryMaxMs: number;
  private readonly interruptedAdapterDrainTimeoutMs: number;
  private readonly onDrainError?: (failure: PendingRecoveryFailure) => void;
  private readonly activeSessions = new Map<string, ActiveSessionRun>();
  private readonly settledActivities = new Map<string, SandboxActivity>();
  private readonly claimRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly claimRetryAttempts = new Map<string, number>();
  private readonly claimHeartbeatStops = new Map<string, () => void>();
  private readonly idleWaiters = new Set<() => void>();
  /**
   * Sessions for which new pending input arrived while their drain loop was
   * still active. The active loop normally observes that input itself; this bit
   * closes the narrower empty→unlock handoff window where it has already
   * observed an empty queue but has not yet removed {@link activeSessions}.
   */
  private readonly wakeRequested = new Set<string>();
  /**
   * One {@link SandboxSession} per session, reused across turns. This is a
   * **lookup** map, NOT a lifecycle registry: the SandboxSession owns its own
   * lifecycle (lazy create on first primitive, transparent self-heal after a
   * gateway reclaim, execution-resource cleanup on dispose). The router only remembers
   * *which* session belongs to a sessionId so the same long-lived binding is
   * reused turn after turn and disposed exactly once at session end. Each entry
   * is a distinct session bound to that Session's EnvSpec — never shared across
   * Sessions.
   */
  private readonly sessions = new Map<string, SandboxSession>();
  private readonly delegationStore?: DelegationStore;
  private readonly delegations?: DelegationCoordinator;
  private readonly maxConcurrentSubagents: number;

  constructor(deps: SessionRouterDeps) {
    this.delegationStore = deps.delegationStore;
    this.maxConcurrentSubagents = deps.maxConcurrentSubagents ?? 4;
    if (!Number.isInteger(this.maxConcurrentSubagents) || this.maxConcurrentSubagents < 1 || this.maxConcurrentSubagents > 64) {
      throw new RangeError("maxConcurrentSubagents must be between 1 and 64");
    }
    const maxSteps = deps.maxSubagentModelSteps ?? 500;
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 1000) throw new RangeError("maxSubagentModelSteps must be between 1 and 1000");
    if (deps.delegationStore) this.delegations = new DelegationCoordinator({
      store: deps.delegationStore, pending: deps.pendingEventStore,
      sessions: deps.sessionStore, maxSteps,
      wake: (sessionId) => {
        if (deps.wakeSession) { deps.wakeSession(sessionId); return; }
        void deps.sessionStore.getById(sessionId).then((session) => {
          if (session && session.status !== "terminated") return this.handleNewEvent(sessionId, session.agent);
        }).catch((error) => this.reportDrainError(sessionId, error));
      },
    });
    this.eventLogStore = deps.eventLogStore;
    this.pendingEventStore = deps.pendingEventStore;
    this.sessionStore = deps.sessionStore;
    this.eventStreamHub = deps.eventStreamHub;
    this.resolveAdapter = deps.resolveAdapter;
    this.sandboxManager = deps.sandboxManager;
    this.workspaceMount = deps.workspaceMount;
    this.agentFileStore = deps.agentFileStore;
    this.agentStore = deps.agentStore;
    this.skillStore = deps.skillStore;
    this.skillArtifactStore = deps.skillArtifactStore;
    this.turnStreamStore = deps.turnStreamStore;
    this.defaultSandboxEnv = deps.defaultSandboxEnv;
    this.managedSandboxEnvByAgentId = deps.managedSandboxEnvByAgentId;
    this.pendingClaimOwnerId = deps.pendingClaimOwnerId ?? `host_${randomUUID()}`;
    this.pendingClaimLeaseMs = deps.pendingClaimLeaseMs ?? 30_000;
    this.pendingClaimRenewIntervalMs = deps.pendingClaimRenewIntervalMs ?? 10_000;
    this.pendingClaimRetryMinMs = deps.pendingClaimRetryMinMs ?? 100;
    this.pendingClaimRetryMaxMs = deps.pendingClaimRetryMaxMs ?? 5_000;
    this.interruptedAdapterDrainTimeoutMs =
      deps.interruptedAdapterDrainTimeoutMs ?? DEFAULT_INTERRUPTED_ADAPTER_DRAIN_TIMEOUT_MS;
    this.onDrainError = deps.onDrainError;
    if (
      this.pendingClaimRenewIntervalMs <= 0 ||
      this.pendingClaimRenewIntervalMs >= this.pendingClaimLeaseMs
    ) {
      throw new RangeError("pending claim renew interval must be positive and shorter than its lease");
    }
    if (
      !Number.isFinite(this.interruptedAdapterDrainTimeoutMs) ||
      this.interruptedAdapterDrainTimeoutMs <= 0
    ) {
      throw new RangeError("interrupted Adapter drain timeout must be a positive finite number");
    }
  }

  private fenceFor(claim: PendingEventClaim): PendingEventFence {
    return {
      eventId: claim.event.id,
      ownerId: claim.ownerId,
      generation: claim.generation,
    };
  }

  private async claimPendingHead(sessionId: string): Promise<PendingEventClaim | null> {
    return this.pendingEventStore.claim(
      sessionId,
      this.pendingClaimOwnerId,
      this.pendingClaimLeaseMs,
    );
  }

  private async renewPendingClaim(
    sessionId: string,
    claim: PendingEventClaim,
  ): Promise<boolean> {
    return this.pendingEventStore.renewClaim(
      sessionId,
      claim.event.id,
      claim,
      this.pendingClaimLeaseMs,
    );
  }

  private turnIdentity(turnId: string): { seq: number; generation: number } | null {
    const generated = /^turn_(\d+)_a(\d+)$/.exec(turnId);
    if (generated) {
      return { seq: Number(generated[1]), generation: Number(generated[2]) };
    }
    const legacy = /^turn_(\d+)$/.exec(turnId);
    return legacy ? { seq: Number(legacy[1]), generation: 0 } : null;
  }

  private async updateActiveTurnProjection(
    sessionId: string,
    next: { turnId: string; status: "running" | "idle" },
  ): Promise<void> {
    if (!this.turnStreamStore) return;
    const nextIdentity = this.turnIdentity(next.turnId);
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = await this.turnStreamStore.getActiveTurn(sessionId);
      const currentIdentity = current ? this.turnIdentity(current.turnId) : null;
      if (
        current &&
        currentIdentity &&
        nextIdentity &&
        (
          currentIdentity.seq > nextIdentity.seq ||
          (currentIdentity.seq === nextIdentity.seq &&
            currentIdentity.generation > nextIdentity.generation)
        )
      ) {
        return;
      }
      if (await this.turnStreamStore.compareAndSetActiveTurn(
        sessionId,
        current?.turnId ?? null,
        next,
      )) return;
    }
    // Redis is a projection: only the PostgreSQL claim can revoke execution.
  }

  private async clearActiveTurnFenced(
    sessionId: string,
    expectedTurnId: string,
  ): Promise<boolean> {
    if (!this.turnStreamStore) return true;
    return this.turnStreamStore.compareAndSetActiveTurn(
      sessionId,
      expectedTurnId,
      null,
    );
  }

  private reportDrainError(sessionId: string, error: unknown): void {
    this.onDrainError?.({ sessionId, error });
  }

  private clearClaimRetry(sessionId: string): void {
    const timer = this.claimRetryTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.claimRetryTimers.delete(sessionId);
  }

  private resetClaimRetry(sessionId: string): void {
    this.clearClaimRetry(sessionId);
    this.claimRetryAttempts.delete(sessionId);
  }

  private scheduleClaimRetry(sessionId: string, agentConfig: Agent): void {
    if (this.activeSessions.has(sessionId) || this.claimRetryTimers.has(sessionId)) return;
    const attempt = (this.claimRetryAttempts.get(sessionId) ?? 0) + 1;
    this.claimRetryAttempts.set(sessionId, attempt);
    const delay = Math.min(
      this.pendingClaimRetryMaxMs,
      this.pendingClaimRetryMinMs * 2 ** Math.min(attempt - 1, 8),
    );
    const timer = setTimeout(() => {
      this.claimRetryTimers.delete(sessionId);
      void this.handleNewEvent(sessionId, agentConfig).catch((error) => {
        this.reportDrainError(sessionId, error);
        this.scheduleClaimRetry(sessionId, agentConfig);
      });
    }, delay);
    this.claimRetryTimers.set(sessionId, timer);
  }

  private notifyIdleIfSettled(): void {
    if (this.activeSessions.size > 0 || this.claimRetryTimers.size > 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  /**
   * Wait for active drainers, including a queued handoff, without aborting or
   * acknowledging their current turns. Used after HTTP stops accepting work.
   */
  async waitForIdle(timeoutMs: number): Promise<boolean> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new RangeError("waitForIdle timeoutMs must be a finite non-negative number");
    }
    if (this.activeSessions.size === 0 && this.claimRetryTimers.size === 0) return true;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.idleWaiters.delete(onIdle);
        resolve(value);
      };
      const onIdle = () => finish(true);
      const timeout = setTimeout(() => finish(false), timeoutMs);
      this.idleWaiters.add(onIdle);
      this.notifyIdleIfSettled();
    });
  }

  private startClaimHeartbeat(
    sessionId: string,
    claim: PendingEventClaim,
    turnController: AbortController,
    onLeaseLost: (error: unknown) => void,
  ): () => void {
    this.claimHeartbeatStops.get(sessionId)?.();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      if (this.claimHeartbeatStops.get(sessionId) === stop) {
        this.claimHeartbeatStops.delete(sessionId);
      }
    };
    const tick = async () => {
      if (stopped || turnController.signal.aborted) return;
      try {
        const renewed = await this.renewPendingClaim(sessionId, claim);
        if (stopped) return;
        if (!renewed) {
          const error = new PendingLeaseLostError();
          onLeaseLost(error);
          turnController.abort(error);
          stop();
          return;
        }
        let shouldInterrupt = await this.pendingEventStore.interruptRequested(sessionId, claim.event.id);
        const execution = await this.delegationStore?.getByPendingEventId(claim.event.id);
        if (execution && this.delegationStore) {
          for (const command of await this.delegationStore.listCommands(execution.id)) {
            if (command.kind !== "interrupt" || command.status !== "accepted") continue;
            await this.delegationStore.applyCommand(command.id, this.fenceFor(claim), {
              type: "session.interrupt_requested", data: { commandId: command.id, turnId: execution.turnId, source: "delegation" },
              sessionThreadId: "sthr_primary", idempotencyKey: `interrupt:${command.id}`,
            });
            shouldInterrupt = true;
          }
        }
        if (shouldInterrupt) { this.interrupt(sessionId); return; }
      } catch (error) {
        if (stopped) return;
        onLeaseLost(error);
        turnController.abort(error);
        stop();
        return;
      }
      if (!stopped) {
        timer = setTimeout(() => void tick(), Math.min(this.pendingClaimRenewIntervalMs, 1000));
      }
    };
    timer = setTimeout(() => void tick(), Math.min(this.pendingClaimRenewIntervalMs, 1000));
    this.claimHeartbeatStops.set(sessionId, stop);
    return stop;
  }

  async handleNewEvent(sessionId: string, agentConfig: Agent): Promise<void> {
    // Usually the active loop will pick up newly queued input itself. Remember
    // the wake as well, so an arrival after its final empty claim cannot be
    // stranded merely because the per-process active marker is still present.
    if (this.activeSessions.has(sessionId)) {
      this.wakeRequested.add(sessionId);
      return;
    }

    // A direct request/recovery trigger supersedes a slower scheduled retry.
    this.clearClaimRetry(sessionId);

    const activeRun: ActiveSessionRun = { controller: new AbortController() };
    this.activeSessions.set(sessionId, activeRun);

    try {
      await this.drainLoop(sessionId, agentConfig, activeRun);
    } finally {
      if (this.activeSessions.get(sessionId) === activeRun) {
        this.activeSessions.delete(sessionId);
      }
      this.wakeRequested.delete(sessionId);

      // Always inspect the durable queue at handoff. This covers the original
      // empty→unlock lost wake, a preloaded tail after user interrupt, and a
      // claim/PG failure that must retry without waiting for a new request.
      try {
        if (await this.pendingEventStore.peek(sessionId)) {
          this.scheduleClaimRetry(sessionId, agentConfig);
        } else {
          this.resetClaimRetry(sessionId);
        }
      } catch (error) {
        this.reportDrainError(sessionId, error);
        this.scheduleClaimRetry(sessionId, agentConfig);
      }
      this.notifyIdleIfSettled();
    }
  }

  /**
   * Recover accepted input retained by the Pending Event Store across a Host
   * restart. Session ids are deduplicated before routing, and all valid work
   * enters through {@link handleNewEvent}, preserving its one-drainer-per-Session
   * gate. Missing/terminated Sessions can never execute again, so their stale
   * queues are explicitly discarded. A failed valid Session is left untouched
   * for the next recovery attempt and does not block other Sessions.
   */
  async recoverPendingEvents(
    onBackgroundError?: (failure: PendingRecoveryFailure) => void,
  ): Promise<PendingRecoverySummary> {
    await this.retrySettledActivities();
    const summary: PendingRecoverySummary = {
      recovered: [],
      discarded: [],
      failed: [],
    };
    // Session termination revokes its pending lease first. Reconcile durable
    // child results even when a Host died before the local cleanup callback.
    await this.delegationStore?.reconcileTerminatedExecutions();
    const sessionIds = new Set(await this.pendingEventStore.listPendingSessionIds());

    for (const sessionId of sessionIds) {
      try {
        const session = await this.sessionStore.getById(sessionId);
        if (!session || session.status === "terminated") {
          await this.pendingEventStore.clear(sessionId);
          summary.discarded.push(sessionId);
          continue;
        }

        // Register the active drainer synchronously, but never await the Agent
        // turn here: a slow LLM/tool/video turn must not block HTTP readiness or
        // serialize recovery of unrelated Sessions. handleNewEvent's local gate
        // makes repeated scans for this Session join the same drainer.
        void this.handleNewEvent(sessionId, session.agent).catch((error) => {
          onBackgroundError?.({ sessionId, error });
        });
        summary.recovered.push(sessionId);
      } catch (error) {
        summary.failed.push({ sessionId, error });
      }
    }

    return summary;
  }

  interrupt(sessionId: string): boolean {
    const activeRun = this.activeSessions.get(sessionId);
    if (!activeRun) {
      this.notifyIdleIfSettled();
      return false;
    }
    this.clearClaimRetry(sessionId);
    this.claimHeartbeatStops.get(sessionId)?.();
    activeRun.controller.abort(new DOMException(SESSION_INTERRUPTED_MESSAGE, "AbortError"));
    this.notifyIdleIfSettled();
    return true;
  }

  /** Accept a durable command; execution confirms interruption in its history. */
  async requestInterrupt(sessionId: string): Promise<{ requested: boolean; interrupted: boolean }> {
    const requested = await this.pendingEventStore.requestInterrupt(sessionId);
    // The owner observes the exact durable input marker on its heartbeat; a
    // local abort here could hit the next Turn after a completion race.
    return { requested, interrupted: false };
  }

  /**
   * Terminate a session: stop the active turn and destroy its sandbox (if one
   * was ever created). Disposal releases execution resources; successfully
   * closed files already belong to the Workspace and are retained.
   */
  async terminateSession(sessionId: string): Promise<void> {
    const activeRun = this.activeSessions.get(sessionId);
    if (activeRun) {
      // Stopped explicitly: after an Interrupt the signal has already fired,
      // and the drain it granted must still end at once.
      activeRun.stopAttempt?.(new DOMException(SESSION_TERMINATED_MESSAGE, "AbortError"));
      this.clearClaimRetry(sessionId);
      this.claimHeartbeatStops.get(sessionId)?.();
      activeRun.controller.abort(new DOMException(SESSION_TERMINATED_MESSAGE, "AbortError"));
    }
    // Termination, unlike an idle user interrupt, intentionally cancels any
    // local recovery timer; the terminated queue is discarded by recovery.
    this.clearClaimRetry(sessionId);
    this.notifyIdleIfSettled();
    await this.pendingEventStore.clear(sessionId);
    const reconciled = await this.delegationStore?.reconcileTerminatedExecutions(sessionId) ?? [];
    for (const execution of reconciled) {
      const parent = await this.sessionStore.getById(execution.callerSessionId);
      if (parent && parent.status !== "terminated") {
        void this.handleNewEvent(parent.id, parent.agent).catch((error) => this.reportDrainError(parent.id, error));
      }
    }
    const session = this.sessions.get(sessionId);
    if (session) await session.dispose();
    // Keep a failed disposal's closed handle so a later DELETE can retry cleanup.
    this.sessions.delete(sessionId);
  }

  /** Retry termination from durable state, including idle Sessions and lost owners. */
  async cleanupTerminatedSession(sessionId: string): Promise<boolean> {
    await this.retrySettledActivities(sessionId);
    const session = await this.sessionStore.getById(sessionId);
    if (!session || session.status !== "terminated") return false;
    const active = this.activeSessions.get(sessionId);
    if (active) {
      active.stopAttempt?.(new DOMException(SESSION_TERMINATED_MESSAGE, "AbortError"));
      active.controller.abort(new DOMException(SESSION_TERMINATED_MESSAGE, "AbortError"));
      return false; // Wait for actual settlement; abort acceptance is not exit proof.
    }
    await this.delegationStore?.reconcileTerminatedExecutions(sessionId);
    const bindingId = session.delegation?.sandboxSessionId ?? session.id;
    // Disposal rechecks shared users under binding coordination. A confirmed
    // missing resource can also clear an obsolete pointer despite old unknown use.
    const sandbox = this.sandboxFor(sessionId, session, session.agent, []);
    if (sandbox) await sandbox.dispose();
    this.sessions.delete(sessionId);
    // Disposal may retain a binding that became busy after our first check.
    // Keep its outbox request until the persistent identity is actually cleared.
    return this.delegationStore
      ? this.delegationStore.withEnvironmentLock(bindingId, async id => ({ sandboxId: id, value: id === null }))
      : true;
  }

  private async finishSettledActivity(activity: SandboxActivity): Promise<void> {
    const key = JSON.stringify([activity.bindingId, activity.sessionId, activity.fence]);
    // This map holds observed exit evidence only. If PG is temporarily down,
    // scans retry recording it; owner loss still leaves unknown activity safe.
    this.settledActivities.set(key, activity);
    await this.sandboxManager?.finishActivity?.(activity);
    await this.delegationStore?.releaseResourceUse(activity.sessionId, activity.fence);
    this.settledActivities.delete(key);
  }

  private async retrySettledActivities(sessionId?: string): Promise<void> {
    for (const activity of this.settledActivities.values()) {
      if (sessionId && activity.sessionId !== sessionId) continue;
      try { await this.finishSettledActivity(activity); }
      catch (error) { this.reportDrainError(activity.sessionId, error); }
    }
  }

  /**
   * Sandbox is mandatory (issue #54): an Agent is sandboxed unless it *explicitly*
   * opts out with `sandbox.enabled === false`. A missing `sandbox` field therefore
   * means sandboxed — a legacy Agent with no sandbox config runs in a sandbox and
   * will fail loud if no manager can be provisioned, which is the intended
   * mandatory behavior. Only an explicit `enabled: false` is treated as opted-out.
   */
  private isSandboxed(agentConfig: Agent): boolean {
    return agentConfig.sandbox?.enabled !== false;
  }

  /**
   * The fail-loud condition (issue #54): the Agent is sandboxed (mandatory by
   * default) but no {@link SandboxManager} was configured, so no sandbox can be
   * provisioned. Running the turn anyway would let the adapter fall back to
   * built-in fs/bash tools writing to the server pod filesystem — the exact bug
   * this guard prevents. When true the router emits a `session.error` and skips
   * the adapter instead of running unsandboxed.
   */
  private isSandboxedButUnprovisionable(agentConfig: Agent): boolean {
    return this.isSandboxed(agentConfig) && !this.sandboxManager;
  }

  /**
   * Compute the complete recipe the SandboxManager needs for this Session
   * (design doc §1/§6). A **value**, no I/O: the tenant/workspace binding, the
   * Agent's image/env, and each validated equipped Skill as a Read-only
   * Projection at `/skills/<skill-name>` outside the persistent Workspace.
   *
   * `equippedSkills` is precomputed by the caller (it needs async store
   * lookups for ownership + non-empty validation), so `specFor` stays a pure
   * value builder. The projection `source` is the weak-typed coordinate the
   * `S3ProvisionSource` (registered under `kind: "s3"` in the manager's deps)
   * reads: `{ tenantId, skillId }` maps straight onto
   * `SkillArtifactStore.getAll` inside the manager (see `S3ProvisionRef`).
   *
   * The sandbox env is the deployment-wide {@link defaultSandboxEnv} overlaid
   * with the Agent's own `sandbox.env`, then any Host-managed values explicitly
   * scoped to this Agent id. Agents may override ordinary defaults (e.g.
   * `VFS_TOKEN`); managed values never cross an Agent boundary.
   */
  private specFor(
    session: Session,
    agent: Agent,
    equippedSkills: EquippedSkill[],
  ): EnvSpec {
    if (!this.workspaceMount) throw new Error("OSS Workspace mount is not configured");
    const mergedEnv = {
      ...this.defaultSandboxEnv,
      ...agent.sandbox?.env,
      ...this.managedSandboxEnvByAgentId?.[agent.id],
      ...WORKSPACE_ENV,
    };
    return {
      tenantId: session.tenantId,
      workspaceId: session.workspaceId,
      workspaceMount: { ...this.workspaceMount, prefix: workspaceObjectPrefix(session.tenantId, session.workspaceId) },
      image: agent.sandbox?.image,
      env: Object.keys(mergedEnv).length > 0 ? mergedEnv : undefined,
      projections: this.skillProjections(session, equippedSkills),
    };
  }

  /**
   * Get (or lazily open) this session's {@link SandboxSession} (design doc §6).
   * `open` is **cheap** — it starts no sandbox; the first filesystem/code
   * primitive triggers create+mount verification+projection — so obtaining it here spins
   * nothing up for a pure-chat turn. The session is remembered in {@link sessions}
   * and reused across turns; it is disposed only at session end.
   *
   * Returns undefined when there is no manager or the agent opted out of the
   * sandbox — in both cases the adapter runs with no injected executor.
   */
  private sandboxFor(
    sessionId: string,
    session: Session,
    agent: Agent,
    equippedSkills: EquippedSkill[],
  ): SandboxSession | undefined {
    if (!this.sandboxManager || !this.isSandboxed(agent)) return undefined;
    let sandbox = this.sessions.get(sessionId);
    if (!sandbox) {
      const bindingId = session.delegation?.sandboxSessionId ?? sessionId;
      sandbox = this.sandboxManager.open(this.specFor(session, agent, equippedSkills), this.delegationStore ? {
        id: bindingId,
        withLock: (work) => this.delegationStore!.withEnvironmentLock(bindingId, work),
        canReclaim: async () => !await this.delegationStore!.hasResourceUsers(bindingId),
        canExecute: async () => (await this.sessionStore.getById(sessionId))?.status !== "terminated",
      } : undefined);
      this.sessions.set(sessionId, sandbox);
    }
    return sandbox; // lazy: no sandbox actually started yet.
  }

  private skillProjections(
    session: Session,
    equippedSkills: EquippedSkill[],
  ): ReadonlyProjection[] {
    return equippedSkills.map(({ id, descriptor }) => ({
      targetPath: `/skills/${descriptor.name}`,
      source: {
        kind: "s3",
        ref: { tenantId: session.tenantId, skillId: id },
      },
    }));
  }

  /** Check availability without changing the completed answer or claiming all handles are saved. */
  private async checkWorkspace(
    journal: TurnJournal,
    sandbox: SandboxSession,
    idempotencyKey: string,
  ): Promise<void> {
    try {
      await sandbox.checkWorkspace();
    } catch {
      const error = {
        message: "Workspace storage could not be checked. The answer is retained; file save status is unconfirmed. Retry the file operation or check the Workspace before continuing.",
        code: "workspace_storage_error",
      };
      journal.record({ type: "session.error", data: { error } }, idempotencyKey);
      await journal.flush();
    }
  }

  /**
   * The one write entry of a Turn attempt (ADR-0020), composed of the
   * attempt's fenced append, live publication and Delta output. A tool result
   * answering a delegation wait is appended by consuming that wait, once the
   * prepared Turn's delegation run exists.
   */
  private createJournal(
    sessionId: string,
    pendingFence: PendingEventFence,
    attempt: AttemptWrites,
    onFail: (error: unknown) => void,
  ): TurnJournal {
    return new TurnJournal({
      sessionId,
      attempt: pendingFence.generation,
      append: async (event, key) => {
        const consumed = attempt.delegationRun &&
          await this.delegations?.consumeResult(attempt.delegationRun, event);
        return consumed ?? this.eventLogStore.append(sessionId, {
          type: event.type,
          data: event.data,
          sessionThreadId: event.sessionThreadId ?? "sthr_primary",
          ...(event.apiKeyId ? { apiKeyId: event.apiKeyId } : {}),
          idempotencyKey: key,
          pendingFence,
        });
      },
      publish: (stored) => this.eventStreamHub.publish(sessionId, {
        type: stored.type,
        seq: stored.seq,
        data: stored.data,
      }),
      // Transient: Deltas go to the per-turn Redis stream for reconnect
      // backfill (never to PostgreSQL), then live to in-process subscribers
      // with the Redis entry id, so live and backfilled frames are identical
      // and a reconnecting client can de-overlap them exactly.
      outputDelta: async (delta) => {
        const deltaId = await this.turnStreamStore?.appendDelta(sessionId, delta);
        this.eventStreamHub.publishChunk(sessionId, { ...delta, deltaId });
      },
      // The Adapter is handed its port only once the mapping is set.
      fromAdapter: (event) => attempt.fromAdapter!(event),
      onFail,
    });
  }

  private turnKey(pendingEventId: string, phase: string): string {
    return `pending:${pendingEventId}:${phase}`;
  }

  private turnCompleted(events: StoredEvent[], pendingEventId: string): boolean {
    return events.some((event) => {
      if (event.type !== "session.turn_completed") return false;
      const data = event.data as { pendingEventId?: unknown } | null;
      return data?.pendingEventId === pendingEventId;
    });
  }

  private async reclaimEarlierAttempts(
    sessionId: string,
    promotedSeq: number,
    claimGeneration: number,
    currentTurnId: string,
  ): Promise<void> {
    if (!this.turnStreamStore) return;
    const staleTurnIds = new Set<string>([`turn_${promotedSeq}`]);
    if (claimGeneration > 1) staleTurnIds.add(`turn_${promotedSeq}_a${claimGeneration - 1}`);
    const active = await this.turnStreamStore.getActiveTurn(sessionId);
    if (active && active.turnId !== currentTurnId) {
      const activeIdentity = this.turnIdentity(active.turnId);
      const currentIdentity = this.turnIdentity(currentTurnId);
      const isExplicitlyOlder = Boolean(
        activeIdentity &&
        currentIdentity &&
        (
          activeIdentity.seq < currentIdentity.seq ||
          (activeIdentity.seq === currentIdentity.seq &&
            activeIdentity.generation < currentIdentity.generation)
        ),
      );
      if (isExplicitlyOlder) {
        staleTurnIds.add(active.turnId);
        await this.clearActiveTurnFenced(sessionId, active.turnId);
      }
    }
    staleTurnIds.delete(currentTurnId);
    for (const staleTurnId of staleTurnIds) {
      await this.turnStreamStore.reclaim(sessionId, staleTurnId);
    }
  }

  /** Record a result for each tool call of the attempt's events that has none. */
  private repairDanglingToolUses(
    journal: TurnJournal,
    pendingEventId: string,
    turnId: string,
    attemptEvents: StoredEvent[],
  ): void {
    attemptEvents = attemptEvents.flatMap(event => presentEvent(event));
    const results = new Set<string>();
    for (const event of attemptEvents) {
      if (event.type !== "agent.tool_result" && event.type !== "agent.mcp_tool_result") continue;
      const data = event.data as { toolUseId?: unknown } | null;
      if (typeof data?.toolUseId === "string") results.add(data.toolUseId);
    }

    for (const event of attemptEvents) {
      if (event.type !== "agent.tool_use" && event.type !== "agent.mcp_tool_use") continue;
      const data = event.data as { toolUseId?: unknown; serverName?: unknown } | null;
      if (typeof data?.toolUseId !== "string" || results.has(data.toolUseId)) continue;
      const isMcp = event.type === "agent.mcp_tool_use";
      const repairedData = {
        id: `recovery_${pendingEventId}_${data.toolUseId}`,
        timestamp: new Date().toISOString(),
        type: isMcp ? "agent.mcp_tool_result" : "agent.tool_result",
        toolUseId: data.toolUseId,
        ...(isMcp
          ? { serverName: typeof data.serverName === "string" ? data.serverName : "unknown" }
          : {}),
        content: [{
          type: "text",
          text: "The previous tool execution was interrupted before a result was committed.",
        }],
        isError: true,
        turnId,
      };
      journal.record({ type: repairedData.type, data: repairedData }, this.turnKey(
        pendingEventId,
        `recovery_tool_result:${encodeURIComponent(data.toolUseId)}`,
      ));
      results.add(data.toolUseId);
    }
  }

  /**
   * Persist the durable turn boundary before acknowledging its pending input.
   * The ordering is the recovery protocol:
   *   full output/storage check → completion marker → atomic ack + idle if empty.
   * A crash before the marker retries under turn-scoped idempotency keys; a
   * crash after the marker only re-acks and never reruns the Adapter.
   */
  private async completeTurn(
    journal: TurnJournal,
    sessionId: string,
    pendingEventId: string,
    turnId: string,
    pendingFence: PendingEventFence,
  ): Promise<boolean> {
    // Write what the attempt recorded first: the Child outcome below is read
    // from the log, and a failed journal must stop the attempt before it
    // finishes the execution or marks the Turn complete.
    await journal.flush();
    const execution = await this.delegationStore?.getByPendingEventId(pendingEventId);
    if (execution && !isTerminalExecution(execution) && this.delegationStore) {
      const log = await this.readAllEvents(sessionId);
      const startSeq = Number(/^turn_(\d+)/.exec(turnId)?.[1] ?? 0);
      const turnEvents = log.filter((event) => event.seq > startSeq);
      const interrupted = turnEvents.some((event) => event.type === "session.turn_aborted");
      const finished = await this.delegationStore.finishExecution(execution.id, pendingFence,
        outcomeFromEvents({ ...execution, turnId }, turnEvents, interrupted));
      // finishExecution commits the parent notification in its transaction,
      // outside the normal Router append/publish path. Publish that durable
      // event before waking the parent so connected clients see arrival even
      // while another parent Turn is still running or waiting synchronously.
      if (finished.notificationEventSeq !== undefined) {
        const notifications = await this.eventLogStore.getEvents(finished.callerSessionId, {
          afterSeq: finished.notificationEventSeq - 1, limit: 1,
        });
        const notification = notifications.data[0];
        if (notification?.seq === finished.notificationEventSeq) {
          this.eventStreamHub.publish(finished.callerSessionId, {
            type: notification.type, seq: notification.seq, data: notification.data,
          });
        }
      }
      const parent = await this.sessionStore.getById(finished.callerSessionId);
      if (parent && parent.status !== "terminated") {
        void this.handleNewEvent(parent.id, parent.agent).catch((error) => this.reportDrainError(parent.id, error));
      }
    }
    const pending = await this.pendingEventStore.peek(sessionId);
    if (pending?.id === pendingEventId && pending.type === "subagent.result" && this.delegationStore) {
      const data = pending.data as { executionId?: string };
      if (data.executionId) await this.delegationStore.markNotificationProcessed(data.executionId, pendingFence);
    }
    await this.delegationStore?.releaseResourceUse(sessionId, pendingFence);
    journal.record({ type: "session.turn_completed", data: { pendingEventId, turnId } },
      this.turnKey(pendingEventId, "completed"));
    await journal.flush();

    return this.acknowledgeCompletedTurn(sessionId, pendingEventId, pendingFence);
  }

  private async acknowledgeCompletedTurn(
    sessionId: string,
    pendingEventId: string,
    pendingFence: PendingEventFence,
  ): Promise<boolean> {
    const result = await this.pendingEventStore.ackCompletedTurn(sessionId, pendingEventId, pendingFence);
    if (result.idleEvent) {
      this.eventStreamHub.publish(sessionId, {
        type: result.idleEvent.type, seq: result.idleEvent.seq, data: result.idleEvent.data,
      });
    }
    return result.acknowledged;
  }

  /**
   * Wait for an Adapter's run() to settle. Once the Turn is aborted it gets at
   * most the drain timeout, and a stopped attempt is not waited for at all;
   * undefined means the runtime has not settled (yet).
   */
  private awaitAdapter(
    run: Promise<AdapterOutcome>,
    signal: AbortSignal,
    stopped: Promise<void>,
  ): Promise<AdapterOutcome | undefined> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: AdapterOutcome | undefined) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", drain);
        resolve(outcome);
      };
      const drain = () => {
        timer = setTimeout(() => finish(undefined), this.interruptedAdapterDrainTimeoutMs);
      };
      if (signal.aborted) drain();
      else signal.addEventListener("abort", drain, { once: true });
      void stopped.then(() => finish(undefined));
      void run.then(finish);
    });
  }

  private async drainLoop(
    sessionId: string,
    agentConfig: Agent,
    activeRun: ActiveSessionRun,
  ): Promise<void> {
    const signal = activeRun.controller.signal;
    let lastOwnedTurnId: string | undefined;
    while (!signal.aborted) {
      const claim = await this.claimPendingHead(sessionId);
      if (!claim) {
        if (await this.pendingEventStore.peek(sessionId)) {
          this.scheduleClaimRetry(sessionId, agentConfig);
        }
        break;
      }
      this.resetClaimRetry(sessionId);
      const pendingEvent = claim.event;
      const pendingFence = this.fenceFor(claim);

      // Enqueue and execution race with termination. Re-read only after claim;
      // a missing/terminated Session can never be revived by status_running.
      const claimedSession = await this.sessionStore.getById(sessionId);
      if (!claimedSession || claimedSession.status === "terminated") {
        await this.pendingEventStore.clear(sessionId);
        break;
      }

      // Set once the attempt no longer owns the Turn: its lease was lost, a
      // journal write failed or the Session was terminated. It then writes no
      // terminal event and leaves its input to the next claim (ADR-0020).
      let stopped = false;
      let sandboxActivity: import('@oma-server/store').SandboxActivity | undefined;
      let activitySandbox: SandboxSession | undefined;
      let executionSettled = false;
      let turnId: string | undefined;
      const turnController = new AbortController();
      const forwardOuterAbort = () => {
        turnController.abort(signal.reason ?? new DOMException("Session interrupted", "AbortError"));
      };
      if (signal.aborted) forwardOuterAbort();
      else signal.addEventListener("abort", forwardOuterAbort, { once: true });
      let markStopped!: () => void;
      const attemptStopped = new Promise<void>((resolve) => { markStopped = resolve; });
      const stopOnFailure = (error: unknown) => {
        // A write failing after the stop is its consequence, not news.
        if (stopped) return;
        this.reportDrainError(sessionId, error);
        stopAttempt(error);
      };
      // Every durable write of this attempt goes through its one journal.
      const attemptWrites: AttemptWrites = {};
      const journal = this.createJournal(sessionId, pendingFence, attemptWrites, stopOnFailure);
      const stopHeartbeat = this.startClaimHeartbeat(sessionId, claim, turnController, stopOnFailure);
      // The one stop path of a lost lease, a failed write and termination: the
      // Adapter loses its write entry and its Turn signal at once. `stopped`
      // is set before the signal aborts: the fenced executor reads it, so the
      // cancellation that abort makes Pi send is refused, not delivered.
      const stopAttempt = (reason: unknown): void => {
        if (stopped) return;
        stopped = true;
        journal.revokeAdapter();
        stopHeartbeat();
        turnController.abort(reason);
        markStopped();
      };
      activeRun.stopAttempt = stopAttempt;

      try {

      // Promote: insert user message into canonical event log (correct seq
      // position). The Turn is named after the seq this assigns, so promotion
      // is the attempt's first journal write, flushed alone, and the journal
      // is bound to the Turn once its name is known below.
      const promotionKey = `pending:${pendingEvent.id}`;
      journal.record({
        type: pendingEvent.type === "subagent.result" ? "subagent.result_claimed" : pendingEvent.type,
        data: pendingEvent.data,
        sessionThreadId: pendingEvent.sessionThreadId,
        apiKeyId: pendingEvent.apiKeyId,
      }, promotionKey);
      await journal.flush();
      const promotedEvent = journal.written(promotionKey)!;

      // Read the complete log once after idempotent promotion. On restart, a
      // completion marker means the durable Turn output already committed. The
      // acknowledgement must still settle Session idle if the queue empties.
      // Never rerun the Adapter in that case.
      let priorEvents = await this.readAllEvents(sessionId);
      turnId = `turn_${promotedEvent.seq}_a${claim.generation}`;
      const waits = await this.delegationStore?.listWaits(sessionId, pendingEvent.id) ?? [];
      const resumableWaits = waits.filter((wait) => wait.status !== "cancelled");
      if (resumableWaits.length) turnId = resumableWaits[0].callerTurnId;
      journal.bindTurn(turnId);
      if (this.turnCompleted(priorEvents, pendingEvent.id)) {
        await this.reclaimEarlierAttempts(
          sessionId,
          promotedEvent.seq,
          claim.generation,
          turnId,
        );
        const acknowledged = await this.acknowledgeCompletedTurn(
          sessionId,
          pendingEvent.id,
          pendingFence,
        );
        if (!acknowledged) return;
        continue;
      }

      let currentAgent = claimedSession.loopId
        ? claimedSession.agent
        : await this.resolveCurrentAgent(agentConfig);
      if (claimedSession.thinking != null) {
        currentAgent = { ...currentAgent, thinking: claimedSession.thinking };
      }
      // Child restrictions belong to the Session, including later direct user
      // input that has no DelegationExecution record for this pending event.
      if (claimedSession.delegation) currentAgent = { ...currentAgent, mcpServers: undefined };
      const waitingConfig = resumableWaits[0]?.config;
      if (waitingConfig?.model) currentAgent = { ...currentAgent, model: waitingConfig.model };
      let delegationExecution: DelegationExecution | null = await this.delegationStore?.getByPendingEventId(pendingEvent.id) ?? null;
      if (delegationExecution && this.delegationStore) {
        currentAgent = { ...currentAgent, mcpServers: undefined,
          model: delegationExecution.model ?? currentAgent.model };
        const started = await this.delegationStore.startExecution(
          delegationExecution.id, pendingFence, turnId,
          { model: currentAgent.model, thinking: delegationExecution.thinking,
            runtime: currentAgent.runtime, maxModelSteps: delegationExecution.maxSteps,
            modelSource: delegationExecution.modelSource ?? (delegationExecution.model ? "override" : "agent") },
          this.maxConcurrentSubagents,
        );
        if (!started) {
          await this.pendingEventStore.releaseClaim(sessionId, pendingEvent.id, pendingFence);
          return;
        }
        delegationExecution = started;
        if (isTerminalExecution(started)) {
          if (started.status === "recovery_required") {
            this.repairDanglingToolUses(journal, pendingEvent.id, started.turnId ?? turnId,
              priorEvents.filter((event) => event.seq > promotedEvent.seq));
            journal.record({ type: "session.error", data: { turnId: started.turnId ?? turnId,
              error: { code: "recovery_required", message: started.result?.reason } } },
            `pending:${pendingEvent.id}:recovery_required`);
          }
          if (!await this.completeTurn(journal, sessionId, pendingEvent.id, started.turnId ?? turnId, pendingFence)) return;
          continue;
        }
      }

      const attemptEvents = priorEvents.filter((event) => event.seq > promotedEvent.seq && event.type !== "subagent.result");
      const alreadyIdle = attemptEvents.some((event) => event.type === "session.status_idle");
      const alreadyTerminal = alreadyIdle || attemptEvents.some((event) =>
        event.type === "session.error" || event.type === "session.turn_aborted");
      const partialDurableOutput = attemptEvents.some(
        (event) => event.type !== "session.status_running",
      );
      if (alreadyTerminal || (partialDurableOutput && resumableWaits.length === 0)) {
        if (alreadyTerminal) await this.delegations?.interruptChildren(claimedSession, turnId, pendingFence);
        this.repairDanglingToolUses(journal, pendingEvent.id, turnId, attemptEvents);
        if (!alreadyTerminal) {
          const recoveryError = {
            message:
              "A previous attempt stopped after committing partial output; it was not rerun to avoid mixing attempts.",
            code: "recovery_partial_turn_aborted",
          };
          journal.record({ type: "session.error", data: { error: recoveryError } },
            this.turnKey(pendingEvent.id, "recovery_partial_turn_aborted"));
        }
        await this.reclaimEarlierAttempts(
          sessionId,
          promotedEvent.seq,
          claim.generation,
          turnId,
        );
        if (this.turnStreamStore) {
          await this.updateActiveTurnProjection(sessionId, { turnId, status: "idle" });
          lastOwnedTurnId = turnId;
        }
        if (!await this.completeTurn(
          journal,
          sessionId,
          pendingEvent.id,
          turnId,
          pendingFence,
        )) return;
        continue;
      }

      // A retry with no durable output is safe. Remove prior transient deltas
      // first; generation in turnId also prevents browser-side concatenation.
      await this.reclaimEarlierAttempts(
        sessionId,
        promotedEvent.seq,
        claim.generation,
        turnId,
      );

      // Record the active turn in Redis (not process memory) so a reconnecting
      // client — possibly on another Host instance — can find and backfill the
      // in-flight turn's deltas.
      if (this.turnStreamStore) {
        await this.updateActiveTurnProjection(sessionId, { turnId, status: "running" });
        lastOwnedTurnId = turnId;
      }

      // Set session status to running
      const runningSession = await this.sessionStore.updateStatusIfClaimed(sessionId, "running", pendingFence);
      if (!runningSession || runningSession.status === "terminated") {
        await this.pendingEventStore.clear(sessionId);
        break;
      }

      // Persist + publish session.status_running now: Sandbox preparation
      // can take seconds, and the Session shows running meanwhile.
      journal.record({ type: "session.status_running", data: {} },
        this.turnKey(pendingEvent.id, "status_running"));
      await journal.flush();

      // Ordinary conversations resolve mutable Agent configuration per Turn.
      // A Loop occurrence is different: ADR-0007 makes the Agent snapshot
      // captured in the same dispatch transaction part of that occurrence.
      // Recovery must therefore use the durable Session snapshot even if the
      // Agent changes after commit but before the pending input is claimed.
      if (stopped) return;

      // Existing Agents keep a retired runtime (claude-code, codex); they are
      // not migrated. Like the managed MCP refusal below, an unsupported
      // runtime is durable, not transient: record one terminal Turn and
      // acknowledge its input, or every claim retry and recovery scan would
      // run it again.
      const adapter = this.resolveAdapter(currentAgent.runtime);
      if (!adapter) {
        journal.record({ type: "session.error", data: { error: {
          code: "unsupported_runtime",
          message: `Agent runtime "${currentAgent.runtime}" is not supported`,
        } } }, this.turnKey(pendingEvent.id, "unsupported_runtime"));
        if (this.turnStreamStore) {
          await this.turnStreamStore.reclaim(sessionId, turnId);
          await this.updateActiveTurnProjection(sessionId, { turnId, status: "idle" });
        }
        if (!await this.completeTurn(
          journal,
          sessionId,
          pendingEvent.id,
          turnId,
          pendingFence,
        )) return;
        continue;
      }

      // Fail-loud (issue #54): a sandboxed Agent with no provisionable manager
      // must NOT run — otherwise the adapter falls back to built-in fs/bash tools
      // that write to the server pod filesystem. Emit a session.error, mark the
      // turn handled (it was already claimed), and skip the adapter for this turn.
      if (this.isSandboxedButUnprovisionable(currentAgent)) {
        const error = {
          message:
            "Agent is sandboxed but no sandbox manager is available (SANDBOX_ENABLED / E2B config missing)",
          code: "sandbox_unavailable",
        };
        journal.record({ type: "session.error", data: { error } },
          this.turnKey(pendingEvent.id, "sandbox_unavailable"));
        // Mirror the normal turn-end housekeeping so the transient stream/active
        // turn record don't leak, then move on to the next pending event (the
        // drain loop falls through to the idle transition when the queue empties).
        if (this.turnStreamStore) {
          await this.turnStreamStore.reclaim(sessionId, turnId);
          await this.updateActiveTurnProjection(sessionId, { turnId, status: "idle" });
        }
        if (!await this.completeTurn(
          journal,
          sessionId,
          pendingEvent.id,
          turnId,
          pendingFence,
        )) return;
        continue;
      }

      // Build adapter input (include history for multi-turn). Read the COMPLETE
      // event history via pagination (issue #82): getEvents defaults to
      // limit 50 / seq ASC, so a single unpaginated call fed the adapter only
      // the OLDEST 50 events — dropping recent turns and potentially leaving a
      // dangling agent.tool_use whose tool_result lived beyond seq 50, which the
      // model API rejects. Loop on `hasMore` using the last seq seen as
      // `afterSeq` so history never silently truncates as a session grows.
      // Select the Agent's valid equipped Skills up front — the async store
      // validation feeds BOTH the EnvSpec projections (via `sandboxFor`) and the
      // in-sandbox `skillPaths` handed to the adapter, so the two never diverge.
      let equippedSkills: EquippedSkill[] = [];

      // Bind the per-session SandboxSession (lazy — no sandbox yet). A pure-chat
      // turn never touches it, so nothing is created. Needs the Session record
      // for its tenant/workspace binding.
      const session = await this.sessionStore.getById(sessionId);
      if (stopped) return;
      if (!session) {
        throw new Error(`Cannot run turn: session ${sessionId} not found`);
      }
      const delegationRun: DelegationRun = { session, turnId, fence: pendingFence,
        signal: turnController.signal, apiKeyId: pendingEvent.apiKeyId,
        effectiveConfig: { model: currentAgent.model }, journal };
      attemptWrites.delegationRun = delegationRun;
      // Sandbox commands are fenced by ownership of this Turn, not by its
      // signal. An Interrupt aborts the Turn while this attempt still owns it,
      // and the Adapter must still be able to stop its own running tool (Pi
      // sends SIGTERM to the tool wrapper through this executor). A stopped
      // attempt owns nothing: it sends the Sandbox no command for the Turn, not
      // even a cancellation. Checked again after the claim read, so a stop that
      // lands during it still wins.
      const assertExecutionOwner = async () => {
        if (!stopped) await this.delegations!.assertClaim(delegationRun);
        if (stopped) throw new PendingEventClaimLostError(sessionId, pendingFence.eventId, pendingFence.ownerId, pendingFence.generation);
      };
      await this.delegationStore?.acquireResourceUse(sessionId,
        session.delegation?.sandboxSessionId ?? sessionId, pendingFence);
      executionSettled = true; // No runtime has started, including preparation failures.
      const activity = { bindingId: session.delegation?.sandboxSessionId ?? sessionId, sessionId, fence: pendingFence };
      if (this.isSandboxed(currentAgent) && await this.sandboxManager?.beginActivity?.(activity, turnController.signal)) {
        sandboxActivity = activity;
        executionSettled = true; // No runtime has started yet.
      }
      let sandbox: SandboxSession | undefined;
      try {
          equippedSkills = await this.equippedSkills(currentAgent);
          if (stopped) return;
          sandbox = this.sandboxFor(sessionId, session, currentAgent, equippedSkills);
          activitySandbox = sandbox;
          await sandbox?.prepare(this.skillProjections(session, equippedSkills));
          if (stopped) return;
        } catch (error) {
          const refreshError = {
            message: error instanceof Error ? error.message : "Sandbox preparation failed",
            code: "sandbox_prepare_failed",
          };
          journal.record({ type: "session.error", data: { error: refreshError } },
            this.turnKey(pendingEvent.id, "sandbox_prepare_failed"));
          if (this.turnStreamStore) {
            await this.turnStreamStore.reclaim(sessionId, turnId);
            await this.updateActiveTurnProjection(sessionId, {
              turnId,
              status: "idle",
            });
          }
          if (!await this.completeTurn(
            journal,
            sessionId,
            pendingEvent.id,
            turnId,
            pendingFence,
          )) return;
          continue;
      }

      // Assemble the Agent's Files into appendSystemPrompt (fixed order, missing
      // skipped). Skills are no longer materialized to a Host temp dir — they are
      // projected into the sandbox by the SandboxManager (ADR-0005 §4); the
      // adapter is pointed at their in-sandbox `/skills/<skill-name>` roots below.
      const appendSystemPrompt = await this.assembleAgentFiles(currentAgent);
      if (sandbox) appendSystemPrompt.push(WORKSPACE_INSTRUCTIONS);
      if (stopped) return;
      const skillPaths = equippedSkills.map(({ descriptor }) => `/skills/${descriptor.name}`);
      const skillDescriptors = equippedSkills.map(({ descriptor }) => descriptor);

      let adapterInput: AdapterInput;
      try {
        if (resumableWaits.length && this.delegations) {
          await this.delegations.recoverWaits(delegationRun, resumableWaits);
          // Consuming the last result records the running transition, written
          // by the next flush: the history handed to the Adapter includes it.
          await journal.flush();
          priorEvents = await this.readAllEvents(sessionId);
          const turnEvents = priorEvents.filter((event) => event.seq > promotedEvent.seq).flatMap(event => presentEvent(event));
          const completedTools = new Set(turnEvents.filter((event) => event.type === "agent.tool_result" || event.type === "agent.mcp_tool_result")
            .map((event) => (event.data as { toolUseId?: string }).toolUseId));
          if (turnEvents.some((event) => (event.type === "agent.tool_use" || event.type === "agent.mcp_tool_use") &&
            !completedTools.has((event.data as { toolUseId?: string }).toolUseId))) {
            this.repairDanglingToolUses(journal, pendingEvent.id, turnId, priorEvents.filter(event => event.seq > promotedEvent.seq));
            journal.record({ type: "session.error", data: { turnId, error: { code: "recovery_required",
              message: "A non-wait tool has an uncertain outcome. Inspect its external effects before continuing in a new Turn." } } },
            `pending:${pendingEvent.id}:unsafe_continuation`);
            if (!await this.completeTurn(journal, sessionId, pendingEvent.id, turnId, pendingFence)) return;
            continue;
          }
        }
        adapterInput = this.buildAdapterInput(
          sessionId,
          turnId,
          journal.adapter,
          promotedEvent,
          currentAgent,
          priorEvents,
          sandbox && this.delegations ? fencedExecutor(sandbox, assertExecutionOwner) : sandbox,
          appendSystemPrompt,
          skillPaths,
          skillDescriptors,
          currentAgent.model,
          // Thread the per-turn abort signal so the adapter can wire it to its
          // runtime's native cancel (issue #84) — a user interrupt then unwedges a
          // hung turn instead of locking the session forever.
          turnController.signal,
        );
        if (this.delegations && currentAgent.runtime === "pi-agent" && !session.delegation) {
          adapterInput.subagents = this.delegations.capability(delegationRun);
        }
        if (session.delegation) {
          adapterInput.execution = {
            isChild: true, maxModelSteps: delegationExecution?.maxSteps ?? 500,
            thinking: delegationExecution?.thinking,
            ...(delegationExecution && this.delegations
              ? { steering: this.delegations.steering(delegationRun, delegationExecution) }
              : {}),
          };
        }
        if (resumableWaits.length) {
          // The resumed wait's Turn continues after what it already committed:
          // its model steps and its output blocks.
          const turnEvents = priorEvents.filter((event) => (event.data as { turnId?: string } | null)?.turnId === turnId);
          adapterInput.history = this.adapterHistory(priorEvents);
          adapterInput.resume = {
            completedModelSteps: turnEvents.filter((event) => event.type === "span.model_request_start").length,
            blockBase: 1 + Math.max(-1, ...turnEvents.flatMap(event => presentEvent(event))
              .map((event) => (event.data as { blockIndex?: number } | null)?.blockIndex ?? -1)),
          };
          if (waitingConfig?.thinking) adapterInput.execution = { ...adapterInput.execution, thinking: waitingConfig.thinking };
        }
        if (this.delegations) adapterInput.execution = { ...adapterInput.execution,
          onResolved: async (config) => {
            await this.delegations!.assertOwner(delegationRun);
            delegationRun.effectiveConfig = { ...config };
            if (delegationExecution) await this.delegationStore!.updateEffectiveConfig(delegationExecution.id, pendingFence, config);
          },
        };
      } catch (error) {
        if (turnController.signal.aborted && !stopped && this.delegations) {
          await this.delegations.interruptChildren(session, turnId, pendingFence);
          await journal.flush();
          const interruptedEvents = await this.readAllEvents(sessionId);
          this.repairDanglingToolUses(journal, pendingEvent.id, turnId,
            interruptedEvents.filter((event) => event.seq > promotedEvent.seq));
          journal.record({ type: "session.turn_aborted", data: { turnId } },
            this.turnKey(pendingEvent.id, "turn_aborted"));
          if (!await this.completeTurn(journal, sessionId, pendingEvent.id, turnId, pendingFence)) return;
          continue;
        }
        if (!(error instanceof ManagedMcpResolutionError)) throw error;
        // Catalog/tenant refusals are durable policy decisions, not transient
        // Adapter failures. Record one terminal Turn and acknowledge its input;
        // retaining it would make every recovery scan retry forever.
        const managedMcpError = {
          message: "A managed MCP connection is unavailable for this Tenant",
          code: "managed_mcp_unavailable",
        };
        journal.record({ type: "session.error", data: { error: managedMcpError } },
          this.turnKey(pendingEvent.id, "managed_mcp_unavailable"));
        if (this.turnStreamStore) {
          await this.turnStreamStore.reclaim(sessionId, turnId);
          await this.updateActiveTurnProjection(sessionId, {
            turnId,
            status: "idle",
          });
        }
        if (!await this.completeTurn(
          journal,
          sessionId,
          pendingEvent.id,
          turnId,
          pendingFence,
        )) return;
        continue;
      }

      let durableEventIndex = 0;
      // Every Adapter event is stamped with its Turn and Child Session caller
      // and keyed once, so the journal writes and publishes it once. The
      // Adapter has given each its final blockIndex (ADR-0020).
      const durableForms = new Map<string, { event: JournalEvent; key: string }>();
      attemptWrites.fromAdapter = (event) => {
        const known = durableForms.get(event.id);
        if (known) return known;
        const completeEvent = delegationExecution ? { ...event, turnId,
          callerSessionId: delegationExecution.callerSessionId,
          callerTurnId: delegationExecution.callerTurnId,
          callerToolUseId: delegationExecution.callerToolUseId,
          executionId: delegationExecution.id,
        } : { ...event, turnId };
        const durable = {
          event: { type: completeEvent.type, data: completeEvent, apiKeyId: pendingEvent.apiKeyId },
          key: this.turnKey(
            pendingEvent.id,
            this.delegations || event.type === "agent.context_start" || event.type === "agent.context_entry" || event.type === "agent.context_usage" || event.type === "agent.compaction"
              ? `event:${event.id}` : `event:${durableEventIndex++}`,
          ),
        };
        durableForms.set(event.id, durable);
        return durable;
      };
      // The Adapter is a pure translator: it runs directly and routes any tool
      // calls through the injected SandboxSession (ADR-0002 §1–2, ADR-0005 §1).
      // There is no separate sandbox orchestrator — the sandbox lives behind the
      // session and is invisible to the router and the adapter alike.
      if (stopped) return;
      executionSettled = false;
      const run = (async () => adapter.run(adapterInput))().then(
        (result): AdapterOutcome => ({ result }),
        (error: unknown): AdapterOutcome => ({ error }),
      );
      const outcome = await this.awaitAdapter(run, turnController.signal, attemptStopped);
      // However the attempt ends, the Adapter loses its write entry before any
      // closing event: what it recorded so far is written by the next flush,
      // anything later is dropped (ADR-0020).
      journal.revokeAdapter();
      if (outcome) {
        executionSettled = true;
      } else if (sandboxActivity) {
        // An expired lease or a bounded Interrupt wait is not proof that the
        // runtime ended. Observe its natural end without blocking the Session.
        const activity = sandboxActivity;
        void run.then(async () => {
          if (activitySandbox?.executionSettled?.() !== false) await this.finishSettledActivity(activity);
        }).catch((error) => this.reportDrainError(sessionId, error));
      }
      if (stopped) {
        if (this.turnStreamStore) await this.turnStreamStore.reclaim(sessionId, turnId);
        return;
      }
      await journal.flush();
      // An Adapter stops before the Turn finishes only at the Host's request
      // (#254). The Turn is left to a later attempt, as on a lost lease.
      if (outcome && "result" in outcome && outcome.result === "stopped") {
        if (this.turnStreamStore) await this.turnStreamStore.reclaim(sessionId, turnId);
        return;
      }
      const interrupted = turnController.signal.aborted;
      // A rejection after an abort is how the abort ended the run, not a failure.
      const failure = outcome && "error" in outcome && !interrupted ? outcome : undefined;
      if (failure) {
        // Signal anything the failed runtime left behind, as an abort would.
        turnController.abort(failure.error);
        journal.record({ type: "session.error", data: { error: { message: String(failure.error), code: "adapter_error" } } },
          this.turnKey(pendingEvent.id, "adapter_error"));
        await journal.flush();
      }

      // A temporary Adapter return cannot finish a Turn that still owns a
      // durable wait. Reclaim the same input and continue from the event log.
      if (!interrupted && !failure && this.delegationStore &&
        (await this.delegationStore.listWaits(sessionId, pendingEvent.id)).some((wait) => wait.status === "waiting")) {
        await journal.flush();
        await this.pendingEventStore.releaseClaim(sessionId, pendingEvent.id, pendingFence);
        return;
      }

      // Interrupted Turn cleanup (issue #112). A Turn stopped while a tool was
      // running leaves the *other* shape of Interrupt: the assistant message is
      // a normal one, and the only trace is a tool_use with no result. Close
      // those orphans with the same repair the restart path uses, and record the
      // Turn-level fact that this Turn was interrupted — a message-level
      // `stopReason` has nowhere to carry it.
      if (interrupted) {
        // The repair reads this attempt's output from the log, including what
        // the Adapter recorded before it lost its write entry.
        await this.delegations?.interruptChildren(session, turnId, pendingFence);
        this.repairDanglingToolUses(journal, pendingEvent.id, turnId,
          (await this.readAllEvents(sessionId)).filter((event) => event.seq > promotedEvent.seq));
        journal.record({ type: "session.turn_aborted", data: { turnId } },
          this.turnKey(pendingEvent.id, "turn_aborted"));
        await journal.flush();
      }

      // Fence the availability check and its optional durable diagnostic.
      const storageCheckLease = await this.renewPendingClaim(sessionId, claim);
      if (!storageCheckLease) {
        stopAttempt(new PendingLeaseLostError());
        if (this.turnStreamStore) await this.turnStreamStore.reclaim(sessionId, turnId);
        return;
      }

      if (sandbox) {
        await this.checkWorkspace(journal, sandbox,
          this.turnKey(pendingEvent.id, "workspace_storage_check"));
      }

      // Fence again before changing global Turn state after the storage check.
      const completionLease = await this.renewPendingClaim(sessionId, claim);
      if (!completionLease) {
        stopAttempt(new PendingLeaseLostError());
        return;
      }

      // The turn's full content is now persisted to PostgreSQL, so the
      // transient delta stream is no longer needed: reclaim it (DEL) and mark
      // the turn idle. This runs on normal completion and after an Interrupt.
      if (this.turnStreamStore) {
        await this.turnStreamStore.reclaim(sessionId, turnId);
        await this.updateActiveTurnProjection(sessionId, { turnId, status: "idle" });
      }

      if (!await this.completeTurn(
        journal,
        sessionId,
        pendingEvent.id,
        turnId,
        pendingFence,
      )) return;
      } catch (error) {
        if (stopped || error instanceof PendingEventClaimLostError) {
          if (turnId && this.turnStreamStore) {
            await this.turnStreamStore.reclaim(sessionId, turnId);
          }
          return;
        }
        throw error;
      } finally {
        // A completed history marker, expired lease or bounded Interrupt wait
        // is not proof of actual runtime settlement.
        try {
          if (sandboxActivity && executionSettled &&
            activitySandbox?.executionSettled?.() !== false) {
            await this.finishSettledActivity(sandboxActivity);
          } else if (executionSettled && activitySandbox?.executionSettled?.() !== false) {
            await this.delegationStore?.releaseResourceUse(sessionId, pendingFence);
          }
        } finally {
          stopHeartbeat();
          signal.removeEventListener("abort", forwardOuterAbort);
          if (activeRun.stopAttempt === stopAttempt) activeRun.stopAttempt = undefined;
        }
      }
    }

    // Every handled Turn persisted its completion before acknowledgement. The
    // last acknowledgement committed Session idle atomically with queue removal.
    // A failed claim alone is never evidence of idle: another Host may own it.
    if (this.turnStreamStore && lastOwnedTurnId) {
      await this.clearActiveTurnFenced(sessionId, lastOwnedTurnId);
    }

    // The session's sandbox (if any was created) is intentionally kept across
    // turns and destroyed only when the session is explicitly terminated, via
    // terminateSession → SandboxSession.dispose.
  }

  /** Resolve mutable Agent configuration live for an existing conversation. */
  private async resolveCurrentAgent(agentSnapshot: Agent): Promise<Agent> {
    if (!this.agentStore) return agentSnapshot;
    const current = await this.agentStore.getById(agentSnapshot.id);
    return current?.tenantId === agentSnapshot.tenantId ? current : agentSnapshot;
  }

  /**
   * Read a session's ENTIRE event log by paginating on `hasMore` (issue #82).
   * `getEvents` defaults to `limit: 50` / `seq ASC`; a single call therefore
   * returns only the oldest page. We walk forward with `afterSeq` = the last
   * seq seen until the store reports no more, so the adapter always receives the
   * full, gap-free history rather than a truncated prefix. Ordering is preserved
   * (each page is seq-ascending and pages are appended in order).
   */
  private async readAllEvents(sessionId: string): Promise<StoredEvent[]> {
    const all: StoredEvent[] = [];
    let afterSeq = 0;
    for (;;) {
      // Each claim reads the whole log: large pages keep that a few statements.
      const { data, hasMore } = await this.eventLogStore.getEvents(sessionId, {
        afterSeq, limit: 1000,
      });
      all.push(...data);
      if (!hasMore || data.length === 0) break;
      afterSeq = data[data.length - 1]!.seq;
    }
    return all;
  }

  private buildAdapterInput(
    sessionId: string,
    turnId: string,
    journal: TurnJournalPort,
    promotedEvent: StoredEvent,
    agentConfig: Agent,
    priorEvents: StoredEvent[],
    toolExecutor?: ToolExecutor,
    appendSystemPrompt?: string[],
    skillPaths?: string[],
    skillDescriptors?: SkillDescriptor[],
    model: string = agentConfig.model,
    signal?: AbortSignal,
  ): AdapterInput {
    const eventData = promotedEvent.data as Record<string, unknown> | undefined;
    let content: ContentBlock[];

    if (eventData && Array.isArray(eventData.content)) {
      content = eventData.content as ContentBlock[];
    } else if (eventData && typeof eventData.text === "string") {
      content = [{ type: "text", text: eventData.text }];
    } else {
      content = [{ type: "text", text: "" }];
    }

    const message: UserMessage = { role: "user", content };
    if (promotedEvent.type === "subagent.result_claimed") {
      message.source = "subagent_result";
      message.content = [{ type: "text", text: JSON.stringify(eventData) }];
    } else if (promotedEvent.type === "delegation.input") message.source = "delegation";

    // History: all events before the current promoted event
    const history = this.adapterHistory(priorEvents.filter((e) => e.seq < promotedEvent.seq));

    return {
      sessionId,
      turnId,
      journal,
      inputEventId: `${sessionId}:${promotedEvent.seq}`,
      message,
      agent: {
        model,
        thinking: agentConfig.thinking,
        system: agentConfig.system,
        tools: agentConfig.tools,
        mcpServers: resolveManagedMcpServers(agentConfig.mcpServers, {
          tenantId: agentConfig.tenantId,
        }),
        skills: agentConfig.skills,
        // Per-call Host injections (ADR-0002): assembled Agent Files and the
        // in-sandbox roots of equipped Skills. `skillPaths` are `/skills/<skill-name>`
        // paths *inside the sandbox* (ADR-0005 §4) — the adapter points Pi's
        // sandbox-mapped read tool at them (SKILL.md at `/skills/<skill-name>/SKILL.md`).
        // Undefined when their stores are absent, preserving prior behavior.
        appendSystemPrompt: appendSystemPrompt && appendSystemPrompt.length > 0
          ? appendSystemPrompt
          : undefined,
        skillPaths: skillPaths && skillPaths.length > 0 ? skillPaths : undefined,
        skillDescriptors:
          skillDescriptors && skillDescriptors.length > 0
            ? skillDescriptors
            : undefined,
      },
      history,
      // Per-call injection: the single seam between the pure Adapter and infra.
      toolExecutor,
      // The turn's abort signal (issue #84): the adapter wires it to its
      // runtime's native cancel so a user interrupt can end a hung turn.
      signal,
    };
  }

  private adapterHistory(events: StoredEvent[]): SessionEvent[] {
    return events.filter((event) => event.type !== "subagent.result")
      .map((event) => ({ id: `${event.sessionId}:${event.seq}`, timestamp: event.ts.toISOString(), ...(event.data as object), type: event.type }) as SessionEvent);
  }

  /**
   * Assemble the running Agent's Files into `appendSystemPrompt` in the fixed
   * order IDENTITY → SOUL → USER → MEMORY, skipping any missing file. Returns
   * an empty array when no store is configured or the Agent has no Files.
   */
  private async assembleAgentFiles(agentConfig: Agent): Promise<string[]> {
    if (!this.agentFileStore) return [];
    const parts: string[] = [];
    for (const filename of AGENT_FILE_ORDER) {
      const file = await this.agentFileStore.get(
        agentConfig.tenantId,
        agentConfig.id,
        filename,
      );
      if (file && file.content.trim().length > 0) parts.push(file.content);
    }
    return parts;
  }

  /**
   * Select the Agent's equipped Skills that should be projected into
   * the sandbox as Read-only Projections at `/skills/<skill-name>` (ADR-0005 §4). This
   * is the *validation* half of the old `materializeSkills`, minus the Host
   * temp-dir write: it decides WHICH Skills become projections/descriptors; the *content*
   * flows S3→sandbox inside the SandboxManager (`S3ProvisionSource`), never
   * through the Host.
   *
   * Preserved behavior, id-for-id, from `materializeSkills`:
   *  - No Skill stores or no equipped Skills ⇒ no ids (no projections).
   *  - A Skill is skipped unless it exists, is in this tenant, and — for
   *    `ownerType==='agent'` — is owned by this Agent. Per ADR-0004
   *    `agent.skills` holds the Agent's own Skill Fork ids, which always exist
   *    while equipped; we still guard on ownership defensively.
   *  - A Skill without its required `SKILL.md` is skipped. We confirm this with
   *    `skillArtifactStore.list` (paths only) rather than
   *    `getAll` (bodies) — the bodies are the manager's job now, so the router
   *    reads only enough to make the include/skip decision.
   */
  private async equippedSkills(agentConfig: Agent): Promise<EquippedSkill[]> {
    const skillIds = agentConfig.skills ?? [];
    if (!this.skillStore || !this.skillArtifactStore || skillIds.length === 0) {
      return [];
    }

    const valid: EquippedSkill[] = [];
    for (const skillId of skillIds) {
      // Only project the Agent's own forks (owned by this Agent, in this
      // tenant). Anything else (missing, cross-tenant, or a stale Library id
      // from pre-fork data) is skipped rather than trusted.
      const skill = await this.skillStore.getById(skillId);
      if (
        !skill ||
        skill.tenantId !== agentConfig.tenantId ||
        skill.ownerType !== "agent" ||
        skill.ownerId !== agentConfig.id
      ) {
        continue;
      }
      // Confirm the Skill has its entrypoint. `list` reads only paths — bytes are projected
      // S3→sandbox by the manager, so the router never touches Skill content.
      const files = await this.skillArtifactStore.list(agentConfig.tenantId, skillId);
      if (!files.includes("SKILL.md")) continue;
      // Names become path components without rewriting: reject ambiguity rather
      // than silently hiding a second equipped Skill behind the first.
      validateArtifactPath(skill.name);
      if (skill.name.includes("/")) throw new Error("Skill name must be one directory name");
      if (valid.some(({ descriptor }) => descriptor.name === skill.name)) {
        throw new Error(`Equipped Skills have a duplicate name: ${skill.name}`);
      }
      valid.push({
        id: skillId,
        descriptor: {
          name: skill.name,
          description: skill.description,
          path: `/skills/${skill.name}/SKILL.md`,
        },
      });
    }
    return valid;
  }
}
