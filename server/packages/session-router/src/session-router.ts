import type {
  EventLogStore,
  PendingEventStore,
  PendingEventClaim,
  PendingEventFence,
  PendingEventRenewal,
  StoredEvent,
  Agent,
  AgentFileStore,
  AgentStore,
  Session,
  SkillStore,
  DelegationStore,
  DelegationExecution,
  SandboxActivity,
} from "@oma-server/store";
import { PendingEventClaimLostError, workspaceObjectPrefix, validateArtifactPath } from "@oma-server/store";
import { ManagedMcpResolutionError, resolveManagedMcpServers } from "@oma-server/mcp-catalog";
import { randomUUID } from "node:crypto";
import type { SessionStore } from "@oma-server/store";
import type { EventStreamHub } from "@oma-server/event-log";
import type { ActiveTurnWriter, TurnStreamStore } from "@oma-server/redis";
import { EMPTY_SKILL_SET, SkillInstallError, skillSetOf } from "@oma-server/sandbox";
import type {
  EnvSpec,
  SandboxManager,
  SandboxSession,
  SkillSet,
  SkillSetMember,
  WorkspaceMountSpec,
} from "@oma-server/sandbox";
import { WORKSPACE_ENV, WORKSPACE_INSTRUCTIONS } from "./workspace-environment.js";
import type {
  Adapter,
  AdapterInput,
  AdapterRunResult,
  DurableEvent,
  SessionEvent,
  ContentBlock,
  ToolExecutor,
  TurnJournalPort,
  UserMessage,
  SkillDescriptor,
} from "@open-managed-agents/adapter-core";
import { DelegationCoordinator, outcomeFromEvents, isTerminalExecution, type DelegationRun } from "./delegation-coordinator.js";
import { TurnJournal, type JournalEvent } from "./turn-journal.js";
import { danglingToolCalls, planResume, type DanglingToolCall, type RecoveryError, type ResumeFacts, type Takeover } from "./plan-resume.js";
import { repairResult, type DanglingCallResolver, type RepairCause } from "./dangling-call-results.js";
import { skillsInstallFailedText, turnExecutor } from "./turn-executor.js";
import { INSTALL_ATTEMPT_STOPPED, SkillInstallSpans, skillInstallKey, unendedSkillInstalls, type SkillInstallEndData } from "./skill-install-spans.js";

/**
 * The fixed assembly order for an Agent's Files into `appendSystemPrompt`.
 * Missing files are skipped. See issue #48.
 */
const AGENT_FILE_ORDER = ["IDENTITY", "SOUL", "USER", "MEMORY"] as const;

const SESSION_INTERRUPTED_MESSAGE = "Session interrupted";
const SESSION_TERMINATED_MESSAGE = "Session terminated";
const RUNNER_SHUTDOWN_MESSAGE = "Runner shutting down";
const DEFAULT_INTERRUPTED_ADAPTER_DRAIN_TIMEOUT_MS = 2_000;

/** How an Adapter's run() settled. */
type AdapterOutcome = { result: AdapterRunResult } | { error: unknown };

interface EquippedSkill {
  id: string;
  descriptor: SkillDescriptor;
  bundle: SkillSetMember;
}

/** What the ports of a Turn attempt's journal learn while the attempt is prepared. */
interface AttemptWrites {
  /** The prepared Turn's delegation run; tool results consume its waits. */
  delegationRun?: DelegationRun;
  /** Durable form and idempotency key of an Adapter event, set before the Adapter runs. */
  fromAdapter?(event: DurableEvent): { event: JournalEvent; key: string };
}

/** The claim heartbeat of one Turn attempt. */
interface ClaimHeartbeat {
  stop(): void;
  /** Renew and read the Interrupt marker and delegation commands now. */
  check(): void;
  /** The Child execution this attempt runs, once started; its Interrupt commands arrive here. */
  execution?: DelegationExecution;
}

interface ActiveSessionRun {
  controller: AbortController;
  /** Stops the running Turn attempt, if any, without terminal events. */
  stopAttempt?: (reason: unknown) => void;
  /**
   * Stops the running Turn attempt, if any, on the same path and hands its
   * Turn over as it stands: the handoff deadline of a shutdown (#254).
   */
  detach?: (reason: unknown) => void;
  /**
   * The drain released its input because its Child execution waits for a
   * slot of the parent's concurrency limit. The sibling that frees one wakes
   * it; the pending scan covers a lost wake.
   */
  waitingForSlot?: boolean;
}

class PendingLeaseLostError extends Error {
  constructor() {
    super("Pending event lease lost");
    this.name = "PendingLeaseLostError";
  }
}

export interface SessionRouterDeps {
  /**
   * Tell every Runner that a Session's input may be claimable: any of them
   * may claim it. Delegation wakes a child with it, and a Runner handing its
   * Turns over (#254) wakes the others for what it leaves.
   */
  wakeSession?: (sessionId: string) => void;
  /**
   * Hint the owner of a Session's running Turn to re-read its durable state
   * now (an accepted Interrupt, a delegation command, a child result): every
   * Runner receives it and calls {@link SessionRouter.checkNow}. Absent ⇒ this
   * Router checks locally. A lost hint costs latency only: the heartbeat and
   * the delegation wait still poll.
   */
  checkSession?: (sessionId: string) => void;
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
   * Tenant Skill metadata. Each Turn the router selects the Agent's
   * *equipped* Skills that are valid (exist, in this tenant, owned by this
   * Agent, with a current Skill Bundle) and hands their Skill Set to the
   * Sandbox session, which installs it at `/skills/<skill-name>` unless the
   * binding records that Set for its Sandbox (ADR-0022). Only PostgreSQL is
   * read here; bundles go from OSS to the Sandbox, never through the Host.
   * Absent ⇒ no Skills.
   *
   * WHY the sandbox and not a Host temp dir (ADR-0005 §4): the Pi adapter runs
   * `noTools: "builtin"` + custom tools, so Pi's prompt tells the model to
   * `read` a Skill's file — and that read is sandbox-mapped. A Skill left on the
   * Host would therefore be unreadable; it MUST be installed into the sandbox.
   */
  skillStore?: SkillStore;
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
  /**
   * Heartbeat cadence, which also bounds how late an Interrupt is seen when
   * its hint is lost. Must be shorter than pendingClaimLeaseMs.
   */
  pendingClaimRenewIntervalMs?: number;
  /**
   * Bounded retry window after a drain failed or left a claimable head (a
   * released claim, input queued behind an Interrupt). A head another Host
   * owns is not retried.
   */
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
  private readonly claimHeartbeats = new Map<string, ClaimHeartbeat>();
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
  /**
   * Results, by tool name, for calls a takeover finds without one, from the
   * durable state the tool keeps (the delegation tools, #251). A call no
   * resolver answers is reported as of unknown outcome.
   */
  private readonly danglingCallResolvers: Readonly<Record<string, DanglingCallResolver>>;
  private readonly maxConcurrentSubagents: number;
  private readonly checkSession: (sessionId: string) => void;
  private readonly wakeSession?: (sessionId: string) => void;
  /**
   * Aborted once this Router hands its Turns over (#254): it claims nothing
   * more, and each running Adapter is asked to stop before its next model
   * request.
   */
  private readonly handoff = new AbortController();

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
      check: (sessionId) => this.checkSession(sessionId),
      wake: (sessionId) => {
        if (deps.wakeSession) { deps.wakeSession(sessionId); return; }
        void deps.sessionStore.getById(sessionId).then((session) => {
          if (session && session.status !== "terminated") return this.handleNewEvent(sessionId, session.agent);
        }).catch((error) => this.reportDrainError(sessionId, error));
      },
    });
    this.danglingCallResolvers = this.delegations?.danglingCallResolvers() ?? {};
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
    this.checkSession = deps.checkSession ?? ((sessionId) => this.checkNow(sessionId));
    this.wakeSession = deps.wakeSession;
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
  ): Promise<PendingEventRenewal> {
    return this.pendingEventStore.renewClaim(
      sessionId,
      claim.event.id,
      claim,
      this.pendingClaimLeaseMs,
    );
  }

  /**
   * The Turn's output is durable and it is completing: its Delta stream, which
   * every attempt of the Turn shares, goes, and the projection shows it idle.
   * Nothing else deletes the stream; one a lost Runner leaves expires.
   */
  private async endTurnStream(sessionId: string, turnId: string, writer: ActiveTurnWriter): Promise<void> {
    if (!this.turnStreamStore) return;
    await this.turnStreamStore.reclaim(sessionId, turnId);
    // A later attempt's projection (one that took the Turn over, or a later
    // input's) stays. Redis is a projection: only the PostgreSQL claim can
    // revoke execution, so a refused write changes nothing else.
    await this.turnStreamStore.recordActiveTurn(sessionId, { turnId, status: "idle", ...writer });
  }

  private reportDrainError(sessionId: string, error: unknown): void {
    this.onDrainError?.({ sessionId, error });
  }

  /**
   * Termination deletes the Session's input, so the attempt of a Session the
   * API terminated finds its claim gone at its next write or heartbeat. That
   * is termination stopping it, not a failure. Any other loss is reported.
   */
  private async reportAttemptFailure(sessionId: string, error: unknown): Promise<void> {
    if (error instanceof PendingEventClaimLostError || error instanceof PendingLeaseLostError) {
      const session = await this.sessionStore.getById(sessionId).catch(() => undefined);
      if (session?.status === "terminated") return;
    }
    this.reportDrainError(sessionId, error);
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

  private get handingOff(): boolean {
    return this.handoff.signal.aborted;
  }

  private scheduleClaimRetry(sessionId: string, agentConfig: Agent): void {
    if (this.handingOff || this.activeSessions.has(sessionId) || this.claimRetryTimers.has(sessionId)) return;
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

  /**
   * Hand this Runner's running Turns to the other Runners as it shuts down
   * (#254). It claims no more input and cancels its claim retries. Each
   * running Adapter is asked to stop before its next model request; tools it
   * runs are not cancelled, so their results are committed. A Turn still
   * running after `timeoutMs` is detached on the one stop path: its write
   * entry is revoked and what it runs in the Sandbox keeps running. Every
   * claim this leaves is released without a terminal event, and the other
   * Runners are woken to take the Turn over at once; a Turn that completes
   * meanwhile leaves the input queued behind it to them the same way.
   *
   * Resolves once every drain has settled, true when no Turn needed
   * detaching. The caller bounds the wait for the releases.
   */
  async handOff(timeoutMs: number): Promise<boolean> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new RangeError("handOff timeoutMs must be a finite non-negative number");
    }
    this.handoff.abort();
    // A head this Router meant to retry is one the other Runners can take.
    for (const sessionId of [...this.claimRetryTimers.keys()]) {
      this.resetClaimRetry(sessionId);
      this.wakeSession?.(sessionId);
    }
    if (await this.waitForIdle(timeoutMs)) return true;
    const reason = new DOMException(RUNNER_SHUTDOWN_MESSAGE, "AbortError");
    for (const activeRun of this.activeSessions.values()) activeRun.detach?.(reason);
    await new Promise<void>((resolve) => {
      this.idleWaiters.add(resolve);
      this.notifyIdleIfSettled();
    });
    return false;
  }

  /**
   * Renew the attempt's claim every renew interval. The renewal reports an
   * accepted Interrupt, and a Child execution's Interrupt commands are read
   * with it. A check hint ({@link checkNow}) runs the same tick at once.
   */
  private startClaimHeartbeat(
    sessionId: string,
    claim: PendingEventClaim,
    turnController: AbortController,
    onLeaseLost: (error: unknown) => void,
  ): ClaimHeartbeat {
    this.claimHeartbeats.get(sessionId)?.stop();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ticking = false;
    let checkAgain = false;
    const lost = (error: unknown) => {
      onLeaseLost(error);
      turnController.abort(error);
      heartbeat.stop();
    };
    const tick = async () => {
      if (stopped || turnController.signal.aborted) return;
      ticking = true;
      clearTimeout(timer);
      try {
        const renewal = await this.renewPendingClaim(sessionId, claim);
        if (stopped) return;
        if (!renewal.renewed) { lost(new PendingLeaseLostError()); return; }
        const execution = heartbeat.execution;
        const commanded = execution !== undefined && await this.applyInterruptCommands(sessionId, execution, this.fenceFor(claim));
        if (renewal.interruptRequested || commanded) { this.interrupt(sessionId); return; }
      } catch (error) {
        if (!stopped) lost(error);
        return;
      } finally {
        ticking = false;
      }
      if (stopped) return;
      // A hint that arrived during this tick may have missed its marker.
      if (checkAgain) { checkAgain = false; void tick(); return; }
      timer = setTimeout(() => void tick(), this.pendingClaimRenewIntervalMs);
    };
    const heartbeat: ClaimHeartbeat = {
      stop: () => {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        if (this.claimHeartbeats.get(sessionId) === heartbeat) this.claimHeartbeats.delete(sessionId);
      },
      check: () => {
        if (stopped) return;
        if (ticking) { checkAgain = true; return; }
        void tick();
      },
    };
    timer = setTimeout(() => void tick(), this.pendingClaimRenewIntervalMs);
    this.claimHeartbeats.set(sessionId, heartbeat);
    return heartbeat;
  }

  /**
   * Record each Interrupt the parent accepted for a Child execution in the
   * child's log, once, under this claim. True when there was one: the Turn
   * must stop.
   */
  private async applyInterruptCommands(sessionId: string, execution: DelegationExecution, fence: PendingEventFence): Promise<boolean> {
    if (!this.delegationStore) return false;
    let accepted = false;
    for (const command of await this.delegationStore.listCommands(execution.id)) {
      if (command.kind !== "interrupt" || command.status !== "accepted") continue;
      const applied = await this.delegationStore.applyCommand(command.id, fence, {
        type: "session.interrupt_requested", data: { commandId: command.id, turnId: execution.turnId, source: "delegation" },
        sessionThreadId: "sthr_primary", idempotencyKey: `interrupt:${command.id}`,
      });
      // The command's transaction appended it, outside the journal.
      if (applied.appliedEventSeq !== undefined) await this.publishCommitted(sessionId, applied.appliedEventSeq);
      accepted = true;
    }
    return accepted;
  }

  /** Publish an event another store transaction committed to the log. */
  private async publishCommitted(sessionId: string, seq: number): Promise<void> {
    const stored = (await this.eventLogStore.getEvents(sessionId, { afterSeq: seq - 1, limit: 1 })).data[0];
    if (stored?.seq === seq) this.eventStreamHub.publish(sessionId, { type: stored.type, seq: stored.seq, data: stored.data });
  }

  /**
   * Re-read the durable state of this Session's running Turn now, if this
   * Router owns it: the claim renewal reports an accepted Interrupt, a Child
   * execution's Interrupt commands are read with it, and a synchronous wait
   * re-reads the execution it waits on. Receiving the hint costs a Runner
   * that does not own the Turn nothing.
   */
  checkNow(sessionId: string): void {
    this.claimHeartbeats.get(sessionId)?.check();
    this.delegations?.recheckWaits(sessionId);
  }

  async handleNewEvent(sessionId: string, agentConfig: Agent): Promise<void> {
    // A Runner handing its Turns over takes none (#254).
    if (this.handingOff) return;
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

    let failed = false;
    try {
      await this.drainLoop(sessionId, agentConfig, activeRun);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (this.activeSessions.get(sessionId) === activeRun) {
        this.activeSessions.delete(sessionId);
      }
      const wokenWhileActive = this.wakeRequested.delete(sessionId);

      // Always inspect the durable queue at handoff. This covers the original
      // empty→unlock lost wake, a preloaded tail after user interrupt, and a
      // claim/PG failure that must retry without waiting for a new request.
      // A head under a live claim is not retried: its owner drains the queue,
      // and the pending scan finds it once a lost owner's lease expires. Nor is
      // a child waiting for a slot, unless the wake of a freed slot arrived
      // while this drain was still releasing its claim.
      try {
        if (this.handingOff) {
          // What the drain left claimable, a Turn it handed over or the input
          // queued behind a Turn it completed, goes to the other Runners now
          // instead of at their next pending scan.
          if (await this.pendingEventStore.headClaimable(sessionId)) this.wakeSession?.(sessionId);
        } else if (failed || ((!activeRun.waitingForSlot || wokenWhileActive) &&
          await this.pendingEventStore.headClaimable(sessionId))) {
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
    this.checkReconciled(await this.delegationStore?.reconcileTerminatedExecutions() ?? []);
    // Only heads no live claim holds: a Runner never contends with an owner.
    const sessionIds = new Set(await this.pendingEventStore.listClaimableSessionIds());

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
    this.claimHeartbeats.get(sessionId)?.stop();
    activeRun.controller.abort(new DOMException(SESSION_INTERRUPTED_MESSAGE, "AbortError"));
    this.notifyIdleIfSettled();
    return true;
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
      this.claimHeartbeats.get(sessionId)?.stop();
      activeRun.controller.abort(new DOMException(SESSION_TERMINATED_MESSAGE, "AbortError"));
    }
    // Termination, unlike an idle user interrupt, intentionally cancels any
    // local recovery timer; the terminated queue is discarded by recovery.
    this.clearClaimRetry(sessionId);
    this.notifyIdleIfSettled();
    await this.pendingEventStore.clear(sessionId);
    const reconciled = await this.delegationStore?.reconcileTerminatedExecutions(sessionId) ?? [];
    this.checkReconciled(reconciled);
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
    this.checkReconciled(await this.delegationStore?.reconcileTerminatedExecutions(sessionId) ?? []);
    const bindingId = session.delegation?.sandboxSessionId ?? session.id;
    // Disposal rechecks shared users under binding coordination. A confirmed
    // missing resource can also clear an obsolete pointer despite old unknown use.
    const sandbox = this.sandboxFor(sessionId, session, session.agent, EMPTY_SKILL_SET);
    if (sandbox) await sandbox.dispose();
    this.sessions.delete(sessionId);
    // Disposal may retain a binding that became busy after our first check.
    // Keep its outbox request until the persistent identity is actually cleared.
    return this.delegationStore
      ? this.delegationStore.withEnvironmentLock(bindingId, async id => ({ sandboxId: id, value: id === null }))
      : true;
  }

  /**
   * Reconciliation interrupts a running child with a command and ends a
   * queued or terminated one: the owners of both sides check at once.
   */
  private checkReconciled(executions: DelegationExecution[]): void {
    for (const execution of executions) {
      this.checkSession(execution.childId);
      this.checkSession(execution.callerSessionId);
    }
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
   * Agent's image/env, and the Skill Set to install at `/skills/<skill-name>`
   * outside the persistent Workspace. The Skill Set is precomputed by the
   * caller (it needs async store lookups for ownership and validation).
   *
   * The sandbox env is the deployment-wide {@link defaultSandboxEnv} overlaid
   * with the Agent's own `sandbox.env`, then any Host-managed values explicitly
   * scoped to this Agent id. Agents may override ordinary defaults (e.g.
   * `VFS_TOKEN`); managed values never cross an Agent boundary.
   */
  private specFor(
    session: Session,
    agent: Agent,
    skills: SkillSet,
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
      skills,
    };
  }

  /**
   * Get (or lazily open) this session's {@link SandboxSession} (design doc §6).
   * `open` is **cheap** — it starts no sandbox; the first filesystem/code
   * primitive triggers create+mount verification+Skill Install — so obtaining it here spins
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
    skills: SkillSet,
  ): SandboxSession | undefined {
    if (!this.sandboxManager || !this.isSandboxed(agent)) return undefined;
    let sandbox = this.sessions.get(sessionId);
    if (!sandbox) {
      // A Child Session shares its root's binding, and so its Skill Install record.
      const bindingId = session.delegation?.sandboxSessionId ?? sessionId;
      const delegationStore = this.delegationStore;
      sandbox = this.sandboxManager.open(this.specFor(session, agent, skills), delegationStore ? {
        id: bindingId,
        withLock: (work) => delegationStore.withEnvironmentLock(bindingId, work),
        canReclaim: async () => !await delegationStore.hasResourceUsers(bindingId),
        canExecute: async () => (await this.sessionStore.getById(sessionId))?.status !== "terminated",
        installedSkills: () => delegationStore.installedSkillSet(bindingId),
        recordSkillsInstalled: (installed) => delegationStore.recordSkillSetInstall(bindingId, installed),
      } : undefined);
      this.sessions.set(sessionId, sandbox);
    }
    return sandbox; // lazy: no sandbox actually started yet.
  }

  /** Check availability without changing the completed answer or claiming all handles are saved. */
  private async checkWorkspace(
    journal: TurnJournal,
    sandbox: SandboxSession,
    pendingEventId: string,
    turnId: string,
  ): Promise<void> {
    try {
      await sandbox.checkWorkspace();
    } catch {
      this.recordTurnError(journal, pendingEventId, turnId, "workspace_storage_check", {
        message: "Workspace storage could not be checked. The answer is retained; file save status is unconfirmed. Retry the file operation or check the Workspace before continuing.",
        code: "workspace_storage_error",
      });
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

  /** The idempotency key of a Router write for an input: `keySegment` names the write among the input's. */
  private turnKey(pendingEventId: string, keySegment: string): string {
    return `pending:${pendingEventId}:${keySegment}`;
  }

  /**
   * Record an error the Router writes itself. It names its Turn as the
   * Adapter's events do, so the Turn's own reads (a Child execution's trace,
   * a console grouping by Turn) include it.
   */
  private recordTurnError(
    journal: TurnJournal,
    pendingEventId: string,
    turnId: string,
    keySegment: string,
    error: { code: string; message?: string },
  ): void {
    journal.record({ type: "session.error", data: { turnId, error } }, this.turnKey(pendingEventId, keySegment));
  }

  /**
   * Record a result for each tool call that has none, and the error that ends
   * its Turn. Each result is keyed by its call, so a repair a lost attempt
   * already wrote is not written twice.
   */
  private async recordRepairs(
    journal: TurnJournal,
    sessionId: string,
    pendingEventId: string,
    turnId: string,
    repairs: readonly DanglingToolCall[],
    outcome: RepairCause,
    error?: RecoveryError,
  ): Promise<void> {
    for (const call of repairs) {
      const isMcp = call.type === "agent.mcp_tool_use";
      const result = await repairResult(call, outcome, this.danglingCallResolvers, { sessionId, turnId, pendingEventId });
      const repairedData = {
        id: `recovery_${pendingEventId}_${call.toolUseId}`,
        timestamp: new Date().toISOString(),
        type: isMcp ? "agent.mcp_tool_result" : "agent.tool_result",
        toolUseId: call.toolUseId,
        ...(isMcp ? { serverName: call.serverName ?? "unknown" } : {}),
        content: result.content,
        isError: result.isError,
        turnId,
      };
      journal.record({ type: repairedData.type, data: repairedData }, this.turnKey(
        pendingEventId,
        `recovery_tool_result:${encodeURIComponent(call.toolUseId)}`,
      ));
    }
    if (error) this.recordTurnError(journal, pendingEventId, turnId, error.keySegment, { code: error.code, message: error.message });
  }

  /** Under the key of the attempt that accepted the Interrupt: whichever attempt writes it, it is written once. */
  private recordTurnAborted(journal: TurnJournal, pendingEventId: string, turnId: string): void {
    journal.record({ type: "session.turn_aborted", data: { turnId } }, this.turnKey(pendingEventId, "turn_aborted"));
  }

  /**
   * Apply an Interrupt to the attempt's own Turn: stop the synchronous
   * children it waits on, give every call left without a result the
   * Interrupt's result and record the Turn as an Interrupted Turn. The
   * repairs read the Turn's output from the log, so the caller has flushed
   * what the attempt recorded, the Adapter's last events included.
   */
  private async interruptTurn(
    journal: TurnJournal,
    session: Session,
    pendingEventId: string,
    promotedSeq: number,
    turnId: string,
    pendingFence: PendingEventFence,
  ): Promise<void> {
    await this.delegations?.interruptChildren(session, turnId, pendingFence);
    const turnEvents = (await this.readAllEvents(session.id)).filter((event) => event.seq > promotedSeq);
    await this.recordRepairs(journal, session.id, pendingEventId, turnId, danglingToolCalls(turnEvents), "interrupted");
    this.recordTurnAborted(journal, pendingEventId, turnId);
  }

  /**
   * End the attempt's Turn because the Skill Install a Sandbox operation
   * waited for failed (ADR-0022): stop the synchronous children it waits on,
   * tell every call left without a result that it was not executed, and
   * record the install's error. The repairs read the Turn's output from the
   * log, so the caller has flushed what the attempt recorded.
   */
  private async failTurnOnSkillInstall(
    journal: TurnJournal,
    session: Session,
    pendingEventId: string,
    promotedSeq: number,
    turnId: string,
    pendingFence: PendingEventFence,
    error: SkillInstallError,
  ): Promise<void> {
    await this.delegations?.interruptChildren(session, turnId, pendingFence);
    const turnEvents = (await this.readAllEvents(session.id)).filter((event) => event.seq > promotedSeq);
    await this.recordRepairs(journal, session.id, pendingEventId, turnId, danglingToolCalls(turnEvents),
      { notExecuted: skillsInstallFailedText(error) });
    this.recordTurnError(journal, pendingEventId, turnId, "skills_install_failed", { code: "skills_install_failed", message: error.message });
  }

  /**
   * Mark that this attempt continues a Turn another claim held, before it
   * writes anything else of the Turn. One marker per takeover: a lost
   * takeover's marker stays, and the next claim writes its own. A Skill
   * Install the stopped attempt left without an end span gets one now: that
   * attempt no longer waits for it, whatever it did (ADR-0022).
   */
  private recordTakeover(journal: TurnJournal, pendingEventId: string, turnId: string, generation: number,
    takeover: Takeover | undefined, events: readonly StoredEvent[]): void {
    if (!takeover) return;
    journal.record({ type: "session.turn_resumed", data: { turnId, generation, ...takeover } },
      this.turnKey(pendingEventId, `turn_resumed:${generation}`));
    for (const start of unendedSkillInstalls(events)) {
      const end: SkillInstallEndData = { ...start, outcome: "aborted", reason: INSTALL_ATTEMPT_STOPPED };
      journal.record({ type: "span.skills_install_end", data: end }, this.turnKey(pendingEventId, skillInstallKey(start.installId, "end")));
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
    promotedSeq: number,
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
      // The Turn is everything after its input, whatever attempt named it.
      const turnEvents = log.filter((event) => event.seq > promotedSeq);
      const interrupted = turnEvents.some((event) => event.type === "session.turn_aborted");
      const finished = await this.delegationStore.finishExecution(execution.id, pendingFence,
        outcomeFromEvents({ ...execution, turnId }, turnEvents, interrupted));
      // finishExecution commits the parent notification in its transaction,
      // outside the normal Router append/publish path. Publish that durable
      // event before waking the parent so connected clients see arrival even
      // while another parent Turn is still running or waiting synchronously.
      if (finished.notificationEventSeq !== undefined) await this.publishCommitted(finished.callerSessionId, finished.notificationEventSeq);
      // A synchronous wait on another Runner reads the result on the hint;
      // the local drain delivers an asynchronous result.
      this.checkSession(finished.callerSessionId);
      void this.delegations?.wakeChildrenWaitingForSlot(finished)
        .catch((error) => this.reportDrainError(finished.callerSessionId, error));
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
    // The acknowledgement is the attempt's last write under its claim, and it
    // deletes the claim row. A heartbeat still running after it would renew a
    // claim that no longer exists and report the lease lost.
    this.claimHeartbeats.get(sessionId)?.stop();
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
    let lastOwnedTurn: ActiveTurnWriter | undefined;
    // A Runner handing its Turns over claims no next input (#254).
    while (!signal.aborted && !this.handingOff) {
      const claim = await this.claimPendingHead(sessionId);
      // An empty or owned head ends the drain; handleNewEvent decides at
      // handoff whether to retry.
      if (!claim) break;
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
      // Set when the attempt hands its Turn over (#254): its claim is
      // released rather than left to expire, so the next claim takes over now.
      let handedOff = false;
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
      // The failure that stopped the attempt, reported once it has ended.
      let failure: { error: unknown } | undefined;
      const stopOnFailure = (error: unknown) => {
        // A write failing after the stop is its consequence, not news.
        if (stopped) return;
        failure = { error };
        stopAttempt(error);
      };
      // The spans of the Skill Installs the attempt's Sandbox runs, once it is
      // prepared, and the failed install a Sandbox operation waited for: it
      // ends the Turn (ADR-0022).
      let skillInstalls: SkillInstallSpans | undefined;
      let installFailure: SkillInstallError | undefined;
      // Every durable write of this attempt goes through its one journal.
      const attemptWrites: AttemptWrites = {};
      const journal = this.createJournal(sessionId, pendingFence, attemptWrites, stopOnFailure);
      const heartbeat = this.startClaimHeartbeat(sessionId, claim, turnController, stopOnFailure);
      const stopHeartbeat = heartbeat.stop;
      // The one stop path of a lost lease, a failed write and termination: the
      // Adapter loses its write entry and its Turn signal at once. `stopped`
      // is set before the signal aborts: the fenced executor reads it, so the
      // cancellation that abort makes Pi send is refused, not delivered.
      const stopAttempt = (reason: unknown): void => {
        if (stopped) return;
        stopped = true;
        // The next attempt ends the spans of installs this one leaves running.
        skillInstalls?.close();
        journal.revokeAdapter();
        stopHeartbeat();
        turnController.abort(reason);
        markStopped();
      };
      activeRun.stopAttempt = stopAttempt;
      // At the handoff deadline the attempt is stopped as it stands. What it
      // runs in the Sandbox keeps running: the stopped attempt's executor
      // refuses even the cancellation Pi sends as its Turn signal aborts.
      const detach = (reason: unknown): void => {
        if (stopped) return;
        handedOff = true;
        stopAttempt(reason);
      };
      activeRun.detach = detach;

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

      // Read the complete log once after idempotent promotion: what earlier
      // attempts made durable decides how this one proceeds.
      let priorEvents = await this.readAllEvents(sessionId);
      const facts: ResumeFacts = {
        pendingEventId: pendingEvent.id, promotedSeq: promotedEvent.seq,
        claim: { generation: claim.generation, priorInterrupt: claim.priorInterrupt, previous: claim.previous },
        events: priorEvents.filter((event) => event.seq > promotedEvent.seq),
        waits: await this.delegationStore?.listWaits(sessionId, pendingEvent.id) ?? [],
      };
      let plan = planResume(facts);
      turnId = plan.turnId;
      journal.bindTurn(turnId);
      // This attempt as a writer of the active-Turn projection: no attempt of
      // an earlier input, or of an earlier generation of this one, replaces
      // what it records.
      const projectionWriter: ActiveTurnWriter = { inputSeq: promotedEvent.seq, generation: claim.generation };
      // Close the Turn as it stands: its Delta stream goes, its completion
      // marker is written and its input acknowledged. False once the attempt
      // lost its claim on the way.
      const endTurn = async (endedTurnId: string): Promise<boolean> => {
        // An install still running ends inside the Turn: its end span precedes
        // the Turn's end, and a complete install is recorded on the binding.
        await skillInstalls?.settled();
        await this.endTurnStream(sessionId, endedTurnId, projectionWriter);
        lastOwnedTurn = projectionWriter;
        return this.completeTurn(journal, sessionId, pendingEvent.id, promotedEvent.seq, endedTurnId, pendingFence);
      };
      // End the Turn with an error the Router records itself, then close it.
      const endTurnWithError = (endedTurnId: string, keySegment: string, error: { code: string; message: string }): Promise<boolean> => {
        this.recordTurnError(journal, pendingEvent.id, endedTurnId, keySegment, error);
        return endTurn(endedTurnId);
      };
      // A completed Turn is never run again. Its acknowledgement must still
      // settle Session idle if the queue empties.
      if (plan.kind === "acknowledge") {
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
      // A Turn keeps the model and thinking its first attempt ran with, so
      // an edit mid-Turn applies from the next Turn; its prompt, Skills and
      // MCP servers are the current ones (#253). A Child execution's own
      // snapshot outranks both.
      if (plan.kind === "run" && plan.config?.model) currentAgent = { ...currentAgent, model: plan.config.model };
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
          activeRun.waitingForSlot = true;
          return;
        }
        delegationExecution = started;
        heartbeat.execution = started;
        // Starting the execution is how this claim learns its state. One that
        // has not ended changes no plan, unless the parent asked to stop it
        // before this claim and its lost owner never did; one that has ended
        // ends the Turn now. A first start has no earlier owner to have missed it.
        const interruptRequested = claim.previous !== null && !isTerminalExecution(started) &&
          (await this.delegationStore.listCommands(started.id)).some((command) => command.kind === "interrupt" && command.status !== "not_applied");
        const executionPlan = planResume({ ...facts, execution: { ...started, interruptRequested } });
        if (executionPlan.kind === "complete" && executionPlan.cause === "execution_ended") {
          this.recordTakeover(journal, pendingEvent.id, executionPlan.turnId, claim.generation, executionPlan.takeover, facts.events);
          await this.recordRepairs(journal, sessionId, pendingEvent.id, executionPlan.turnId, executionPlan.repairs,
            executionPlan.repairOutcome, executionPlan.error);
          if (!await endTurn(executionPlan.turnId)) return;
          continue;
        }
        if (executionPlan.kind !== "acknowledge") plan = executionPlan;
      }

      this.recordTakeover(journal, pendingEvent.id, turnId, claim.generation, plan.takeover, facts.events);
      if (plan.kind === "complete") {
        if (plan.cause === "interrupted" && delegationExecution) {
          // The parent's Interrupt takes effect now, after the takeover marker:
          // the child's log records it as its lost owner would have.
          await journal.flush();
          await this.applyInterruptCommands(sessionId, delegationExecution, pendingFence);
        }
        if (plan.interruptChildren) await this.delegations?.interruptChildren(claimedSession, turnId, pendingFence);
        await this.recordRepairs(journal, sessionId, pendingEvent.id, turnId, plan.repairs, plan.repairOutcome, plan.error);
        if (plan.cause === "interrupted") this.recordTurnAborted(journal, pendingEvent.id, turnId);
        if (!await endTurn(turnId)) return;
        continue;
      }

      // Record the active turn in Redis (not process memory) so a reconnecting
      // client — possibly on another Host instance — can find and backfill the
      // in-flight turn's deltas. Earlier attempts of the Turn streamed into the
      // same stream; each Delta carries its attempt, and consoles keep only the
      // highest one's.
      if (this.turnStreamStore) {
        await this.turnStreamStore.recordActiveTurn(sessionId, { turnId, status: "running", ...projectionWriter });
        lastOwnedTurn = projectionWriter;
      }

      // Set session status to running
      const runningSession = await this.sessionStore.updateStatusIfClaimed(sessionId, "running", pendingFence);
      if (!runningSession || runningSession.status === "terminated") {
        await this.pendingEventStore.clear(sessionId);
        break;
      }

      // A takeover answers the calls the lost attempt left without a result
      // before anything runs; nothing is executed again (ADR-0021).
      await this.recordRepairs(journal, sessionId, pendingEvent.id, turnId, plan.repairs, "unknown");
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
      // A Runner handing its Turns over prepares no Sandbox and resumes no
      // wait for a Turn it would stop at once; the takeover marker is written.
      if (this.handingOff) { handedOff = true; return; }

      // Existing Agents keep a retired runtime (claude-code, codex); they are
      // not migrated. Like the managed MCP refusal below, an unsupported
      // runtime is durable, not transient: record one terminal Turn and
      // acknowledge its input, or every claim retry and recovery scan would
      // run it again.
      const adapter = this.resolveAdapter(currentAgent.runtime);
      if (!adapter) {
        if (!await endTurnWithError(turnId, "unsupported_runtime", {
          code: "unsupported_runtime",
          message: `Agent runtime "${currentAgent.runtime}" is not supported`,
        })) return;
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
        if (!await endTurnWithError(turnId, "sandbox_unavailable", error)) return;
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
      // validation feeds BOTH the Skill Set the Sandbox installs and the
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
          const skills = skillSetOf(equippedSkills.map(({ bundle }) => bundle));
          sandbox = this.sandboxFor(sessionId, session, currentAgent, skills);
          activitySandbox = sandbox;
          skillInstalls = new SkillInstallSpans({ turnId, generation: claim.generation, write: (event, keySegment) => {
            journal.record(event, this.turnKey(pendingEvent.id, keySegment));
            // Written at once, so the stream shows it live; a failed write
            // stops the attempt through the journal.
            journal.flush().catch(() => {});
          } });
          // The Skill Set is computed per attempt: a Resumed Turn installs the
          // current one. Preparation verifies the mount and decides the
          // install; the install runs beside inference, and the first Sandbox
          // operation waits for it (ADR-0022).
          await sandbox?.prepare(skills, { signal: turnController.signal, skillInstalls });
          if (stopped) return;
        } catch (error) {
          // Deciding the install can fail (reading the binding's record); its
          // stage names that, and its reason carries no URL.
          const code = error instanceof SkillInstallError ? "skills_install_failed" : "sandbox_prepare_failed";
          const refreshError = {
            message: error instanceof Error ? error.message : "Sandbox preparation failed",
            code,
          };
          if (!await endTurnWithError(turnId, code, refreshError)) return;
          continue;
      }

      // Assemble the Agent's Files into appendSystemPrompt (fixed order, missing
      // skipped). Skills are not materialized on the Host — the SandboxManager
      // installs them into the sandbox (ADR-0022); the adapter is pointed at
      // their in-sandbox `/skills/<skill-name>` roots below.
      const appendSystemPrompt = await this.assembleAgentFiles(currentAgent);
      if (sandbox) appendSystemPrompt.push(WORKSPACE_INSTRUCTIONS);
      if (stopped) return;
      const skillPaths = equippedSkills.map(({ descriptor }) => `/skills/${descriptor.name}`);
      const skillDescriptors = equippedSkills.map(({ descriptor }) => descriptor);

      let adapterInput: AdapterInput;
      try {
        if (plan.waits.length && this.delegations) {
          await this.delegations.recoverWaits(delegationRun, plan.waits);
          // Consuming the last result records the running transition, written
          // by the next flush: the history handed to the Adapter includes it.
          await journal.flush();
        }
        // The Adapter continues from the history as it is now, with the
        // results this attempt wrote for the calls it found dangling.
        if (plan.waits.length || plan.repairs.length) priorEvents = await this.readAllEvents(sessionId);
        adapterInput = this.buildAdapterInput(
          sessionId,
          turnId,
          journal.adapter,
          promotedEvent,
          currentAgent,
          priorEvents,
          sandbox && turnExecutor(sandbox, {
            ...(this.delegations ? { assertOwner: assertExecutionOwner } : {}),
            // The first operation to find the install failed ends the Turn:
            // the Adapter run is aborted and the Turn closed with its error.
            // A Turn already stopping or interrupted ends as it would anyway.
            skillInstallFailed: (error) => {
              if (installFailure || turnController.signal.aborted) return;
              installFailure = error;
              turnController.abort(error);
            },
          }),
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
        // A continued Turn picks up after what it already committed: its
        // model steps and its output blocks.
        if (plan.start === "continue") adapterInput.resume = plan.progress;
        if (plan.config?.thinking) adapterInput.execution = { ...adapterInput.execution,
          thinking: adapterInput.execution?.thinking ?? plan.config.thinking };
        if (this.delegations) adapterInput.execution = { ...adapterInput.execution,
          onResolved: async (config) => {
            await this.delegations!.assertOwner(delegationRun);
            delegationRun.effectiveConfig = { ...config };
            // The attempt that started the Turn recorded its configuration on
            // the execution before it named the Turn's model and thinking. A
            // later attempt runs with those (#253): recording them again would
            // relabel the pinned thinking as an override.
            if (delegationExecution && !plan.config) await this.delegationStore!.updateEffectiveConfig(delegationExecution.id, pendingFence, config);
          },
        };
      } catch (error) {
        if (turnController.signal.aborted && !stopped && this.delegations) {
          // The repairs read the log: first write what preparing the input
          // recorded, such as a resumed wait's transitions.
          await journal.flush();
          await this.interruptTurn(journal, session, pendingEvent.id, promotedEvent.seq, turnId, pendingFence);
          if (!await endTurn(turnId)) return;
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
        if (!await endTurnWithError(turnId, "managed_mcp_unavailable", managedMcpError)) return;
        continue;
      }

      // Every Adapter event is stamped with its Turn and Child Session caller
      // and keyed by its id, so the journal writes and publishes it once and
      // no attempt's event takes another's key. The Adapter has given each
      // its final blockIndex (ADR-0020).
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
          key: this.turnKey(pendingEvent.id, `event:${event.id}`),
        };
        durableForms.set(event.id, durable);
        return durable;
      };
      // The Adapter is a pure translator: it runs directly and routes any tool
      // calls through the injected SandboxSession (ADR-0002 §1–2, ADR-0005 §1).
      // There is no separate sandbox orchestrator — the sandbox lives behind the
      // session and is invisible to the router and the adapter alike.
      if (stopped) return;
      if (this.handingOff) { handedOff = true; return; }
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
      } else if (sandboxActivity && !handedOff) {
        // An expired lease or a bounded Interrupt wait is not proof that the
        // runtime ended. Observe its natural end without blocking the Session.
        // A Turn detached at the handoff deadline is not watched: this Runner
        // is exiting, and the next owner's admitted generation supersedes the
        // abandoned activity (ADR-0019).
        const activity = sandboxActivity;
        void run.then(async () => {
          if (activitySandbox?.executionSettled?.() !== false) await this.finishSettledActivity(activity);
        }).catch((error) => this.reportDrainError(sessionId, error));
      }
      // A stopped attempt leaves the Turn, and the Delta stream all its
      // attempts share, to the attempt that continues it.
      if (stopped) return;
      await journal.flush();
      // An Adapter stops before the Turn finishes only at the Host's request,
      // a handoff (#254): the Turn goes to the next claim as it stands.
      if (outcome && "result" in outcome && outcome.result === "stopped") { handedOff = true; return; }
      // The Skill Install a Sandbox operation waited for failed: the operation
      // did not run, and the Turn ends with the install's error.
      if (installFailure) {
        await this.failTurnOnSkillInstall(journal, session, pendingEvent.id, promotedEvent.seq, turnId, pendingFence, installFailure);
        if (!await endTurn(turnId)) return;
        continue;
      }
      const interrupted = turnController.signal.aborted;
      // A rejection after an abort is how the abort ended the run, not a failure.
      const failure = outcome && "error" in outcome && !interrupted ? outcome : undefined;
      if (failure) {
        // Signal anything the failed runtime left behind, as an abort would.
        turnController.abort(failure.error);
        this.recordTurnError(journal, pendingEvent.id, turnId, "adapter_error", { message: String(failure.error), code: "adapter_error" });
        await journal.flush();
      }
      // A Turn that made no Sandbox operation never waited for its install,
      // but its end does, whatever came of it: a failure is recorded only in
      // the install's end span, the binding records nothing, and the next
      // Turn installs again (ADR-0022). An aborted Turn cancelled it.
      await skillInstalls?.settled();

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
        await this.interruptTurn(journal, session, pendingEvent.id, promotedEvent.seq, turnId, pendingFence);
        await journal.flush();
      }

      // Fence the availability check and its optional durable diagnostic.
      const storageCheckLease = await this.renewPendingClaim(sessionId, claim);
      if (!storageCheckLease.renewed) {
        stopAttempt(new PendingLeaseLostError());
        return;
      }

      if (sandbox) {
        await this.checkWorkspace(journal, sandbox, pendingEvent.id, turnId);
      }

      // Fence again before changing global Turn state after the storage check.
      const completionLease = await this.renewPendingClaim(sessionId, claim);
      if (!completionLease.renewed) {
        stopAttempt(new PendingLeaseLostError());
        return;
      }

      // The turn's full content is now persisted to PostgreSQL, so the
      // transient delta stream is no longer needed: reclaim it (DEL) and mark
      // the turn idle. This runs on normal completion and after an Interrupt.
      if (!await endTurn(turnId)) return;
      } catch (error) {
        if (stopped || error instanceof PendingEventClaimLostError) return;
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
          skillInstalls?.close();
          stopHeartbeat();
          signal.removeEventListener("abort", forwardOuterAbort);
          if (activeRun.stopAttempt === stopAttempt) activeRun.stopAttempt = undefined;
          if (activeRun.detach === detach) activeRun.detach = undefined;
          if (failure) await this.reportAttemptFailure(sessionId, failure.error);
          // Released, not left to expire: the next claim learns the Turn was
          // handed over, which no takeover limit counts, and need not wait.
          if (handedOff) await this.pendingEventStore.releaseClaim(sessionId, pendingEvent.id, pendingFence);
        }
      }
    }

    // Every handled Turn persisted its completion before acknowledgement. The
    // last acknowledgement committed Session idle atomically with queue removal.
    // A failed claim alone is never evidence of idle: another Host may own it.
    if (this.turnStreamStore && lastOwnedTurn) {
      await this.turnStreamStore.clearActiveTurn(sessionId, lastOwnedTurn);
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

    // History: everything committed but the input itself, which the Adapter
    // is handed as `message`. A Turn earlier attempts started keeps what they
    // committed after the input: its native chain, and the results written
    // for calls they left without one.
    const history = this.adapterHistory(priorEvents.filter((e) => e.seq !== promotedEvent.seq));

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
      // A handoff stops the Turn before its next model request (#254).
      stopRequest: this.handoff.signal,
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
   * Select the Agent's equipped Skills for this Turn: its Skill Set and the
   * prompt's Skill descriptors (ADR-0022). Only PostgreSQL is read.
   *
   *  - No Skill store or no equipped Skills ⇒ none.
   *  - A Skill is skipped unless it exists, is in this tenant and is owned by
   *    this Agent: per ADR-0004 `agent.skills` holds the Agent's own Skill Fork
   *    ids, which always exist while equipped; ownership is still checked.
   *  - A Skill without a Skill Bundle has no files to install and is skipped.
   *  - Names become `/skills/<name>`: an unsafe or duplicate name fails the
   *    Turn visibly before execution instead of hiding a Skill.
   */
  private async equippedSkills(agentConfig: Agent): Promise<EquippedSkill[]> {
    const skillIds = agentConfig.skills ?? [];
    if (!this.skillStore || skillIds.length === 0) {
      return [];
    }

    const valid: EquippedSkill[] = [];
    for (const skillId of skillIds) {
      // Only install the Agent's own forks (owned by this Agent, in this
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
      if (skill.bundleSha256 === null || skill.bundleSize === null) continue;
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
        bundle: { name: skill.name, sha256: skill.bundleSha256, size: skill.bundleSize },
      });
    }
    return valid;
  }
}
