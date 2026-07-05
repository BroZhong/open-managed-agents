import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  EventLogStore,
  PendingEventStore,
  PendingEvent,
  StoredEvent,
  Agent,
  AgentFileStore,
  AgentStore,
  SkillStore,
  SkillArtifactStore,
} from "@oma-server/store";
import type { SessionStore } from "@oma-server/store";
import type { EventStreamHub } from "@oma-server/event-log";
import type { TurnStreamStore } from "@oma-server/redis";
import type {
  ToolExecutorFactory,
  WorkspaceBinding,
  WorkspaceSyncResult,
} from "@oma-server/sandbox";
import { syncHasChanges } from "@oma-server/sandbox";
import type {
  Adapter,
  AdapterInput,
  SessionEvent,
  ContentBlock,
  ToolExecutor,
  UserMessage,
} from "@open-managed-agents/adapter-core";
import { isStreamEvent } from "@open-managed-agents/adapter-core";

/**
 * A per-session tool executor that syncs its Workspace back to S3 at
 * tool-execution points and must be torn down when the session ends.
 * `SandboxToolExecutor` satisfies this; the router only needs the
 * `ToolExecutor` surface plus `sync` + `dispose`.
 */
type DisposableToolExecutor = ToolExecutor & {
  sync(): Promise<WorkspaceSyncResult>;
  dispose(): Promise<void>;
};

/**
 * The fixed assembly order for an Agent's Files into `appendSystemPrompt`.
 * Missing files are skipped. See issue #48.
 */
const AGENT_FILE_ORDER = ["IDENTITY", "SOUL", "USER", "MEMORY"] as const;

/** Stream event types that open a new content block within a turn. */
const STREAM_START_TYPES: ReadonlySet<string> = new Set([
  "agent.message_stream_start",
  "agent.thinking_stream_start",
  "agent.tool_use_input_stream_start",
]);

export interface SessionRouterDeps {
  eventLogStore: EventLogStore;
  pendingEventStore: PendingEventStore;
  sessionStore: SessionStore;
  eventStreamHub: EventStreamHub;
  resolveAdapter: (runtime: string) => Adapter;
  /**
   * Produces a sandbox-backed {@link ToolExecutor} bound to a session's
   * Workspace (ADR-0002 §4). When present and the agent is sandboxed, the
   * router injects the executor per `run()` call and disposes it — destroying
   * the sandbox — at session end. Absent ⇒ adapters run with no injected
   * executor (their own tool execution, no sandbox).
   */
  toolExecutorFactory?: ToolExecutorFactory;
  /**
   * Per-Agent editable Files (IDENTITY/SOUL/USER/MEMORY). When present, the
   * router assembles the running Agent's Files into `appendSystemPrompt` in a
   * fixed order before each turn (issue #48). Absent ⇒ no instructions
   * assembled (no regression). See ADR-0002: the Host owns *what* to inject.
   */
  agentFileStore?: AgentFileStore;
  /**
   * The tenant's Agent config store. When present, the router resolves the
   * running Agent's **current model** per turn (issue #59 / ADR-0003 §3),
   * rather than using the model snapshotted onto the Session at creation. This
   * makes an Agent model change take effect on existing conversations. Only the
   * model is resolved live; all other Session-snapshot semantics are unchanged.
   * Absent ⇒ the snapshot model is used (prior behavior).
   */
  agentStore?: AgentStore;
  /**
   * Tenant Skill Library metadata + S3 bodies. When both are present, the
   * router materializes the Agent's *equipped* Skills (`agent.skills`) into a
   * Host-side temp directory per turn, passes them as `skillPaths`, and cleans
   * them up at turn end (issue #49). Absent ⇒ no Skills materialized.
   */
  skillStore?: SkillStore;
  skillArtifactStore?: SkillArtifactStore;
  /**
   * Transient per-turn delta stream + active-turn map (Redis). When present,
   * token-level deltas are written to `stream:turn:{turnId}` for server-side
   * reconnect backfill and reclaimed (DEL) at turn end; the active-turn map is
   * kept in Redis so multi-instance reconnect stays correct. Deltas are never
   * persisted to PostgreSQL. When absent, deltas are live-only (hub chunks).
   */
  turnStreamStore?: TurnStreamStore;
}

export class SessionRouter {
  private readonly eventLogStore: EventLogStore;
  private readonly pendingEventStore: PendingEventStore;
  private readonly sessionStore: SessionStore;
  private readonly eventStreamHub: EventStreamHub;
  private readonly resolveAdapter: (runtime: string) => Adapter;
  private readonly toolExecutorFactory?: ToolExecutorFactory;
  private readonly agentFileStore?: AgentFileStore;
  private readonly agentStore?: AgentStore;
  private readonly skillStore?: SkillStore;
  private readonly skillArtifactStore?: SkillArtifactStore;
  private readonly turnStreamStore?: TurnStreamStore;
  private readonly activeSessions = new Map<string, AbortController>();
  /**
   * One executor per session, reused across turns so the sandbox (created
   * lazily on first tool use) persists for the session's life and is destroyed
   * only at session end. Never a shared mutable registry across sessions —
   * each entry is a distinct executor bound to that session's Workspace.
   */
  private readonly sessionExecutors = new Map<string, DisposableToolExecutor>();

  constructor(deps: SessionRouterDeps) {
    this.eventLogStore = deps.eventLogStore;
    this.pendingEventStore = deps.pendingEventStore;
    this.sessionStore = deps.sessionStore;
    this.eventStreamHub = deps.eventStreamHub;
    this.resolveAdapter = deps.resolveAdapter;
    this.toolExecutorFactory = deps.toolExecutorFactory;
    this.agentFileStore = deps.agentFileStore;
    this.agentStore = deps.agentStore;
    this.skillStore = deps.skillStore;
    this.skillArtifactStore = deps.skillArtifactStore;
    this.turnStreamStore = deps.turnStreamStore;
  }

  async handleNewEvent(sessionId: string, agentConfig: Agent): Promise<void> {
    // If session is already running, return — the active loop will pick up new events
    if (this.activeSessions.has(sessionId)) {
      return;
    }

    const abortController = new AbortController();
    this.activeSessions.set(sessionId, abortController);

    try {
      await this.drainLoop(sessionId, agentConfig, abortController.signal);
    } finally {
      this.activeSessions.delete(sessionId);
    }
  }

  interrupt(sessionId: string): void {
    const controller = this.activeSessions.get(sessionId);
    if (controller) {
      controller.abort();
    }
  }

  /**
   * Terminate a session: stop the active turn and destroy its sandbox (if one
   * was ever created). Disposing the executor tears the sandbox down; a
   * pure-chat session that never created one disposes to a no-op.
   */
  async terminateSession(sessionId: string): Promise<void> {
    this.interrupt(sessionId);
    await this.disposeExecutor(sessionId);
  }

  /**
   * Sandbox is mandatory (issue #54): an Agent is sandboxed unless it *explicitly*
   * opts out with `sandbox.enabled === false`. A missing `sandbox` field therefore
   * means sandboxed — a legacy Agent with no sandbox config runs in a sandbox and
   * will fail loud if no executor can be provisioned, which is the intended
   * mandatory behavior. Only an explicit `enabled: false` is treated as opted-out.
   */
  private isSandboxed(agentConfig: Agent): boolean {
    return agentConfig.sandbox?.enabled !== false;
  }

  /**
   * Get (or lazily construct) this session's sandbox-backed executor. The
   * executor object itself does not create a sandbox — that happens lazily on
   * its first filesystem/code call — so obtaining it here is cheap and does
   * not spin anything up for a pure-chat turn.
   */
  /**
   * The fail-loud condition (issue #54): the Agent is sandboxed (mandatory by
   * default) but no {@link ToolExecutorFactory} was configured, so no sandbox
   * executor can be provisioned. Running the turn anyway would let the adapter
   * fall back to built-in fs/bash tools writing to the server pod filesystem —
   * the exact bug this guard prevents. When true the router emits a
   * `session.error` and skips the adapter instead of running unsandboxed.
   */
  private isSandboxedButUnprovisionable(agentConfig: Agent): boolean {
    return this.isSandboxed(agentConfig) && !this.toolExecutorFactory;
  }

  private async getExecutorForSession(
    sessionId: string,
    agentConfig: Agent,
  ): Promise<DisposableToolExecutor | undefined> {
    if (!this.toolExecutorFactory || !this.isSandboxed(agentConfig)) {
      return undefined;
    }
    const existing = this.sessionExecutors.get(sessionId);
    if (existing) return existing;

    const binding = await this.resolveWorkspaceBinding(sessionId, agentConfig);
    const executor = this.toolExecutorFactory.create(binding) as DisposableToolExecutor;
    this.sessionExecutors.set(sessionId, executor);
    return executor;
  }

  private async resolveWorkspaceBinding(
    sessionId: string,
    agentConfig: Agent,
  ): Promise<WorkspaceBinding> {
    const session = await this.sessionStore.getById(sessionId);
    if (!session) {
      throw new Error(`Cannot bind executor: session ${sessionId} not found`);
    }
    return {
      tenantId: session.tenantId,
      workspaceId: session.workspaceId,
      image: agentConfig.sandbox?.image,
    };
  }

  private async disposeExecutor(sessionId: string): Promise<void> {
    const executor = this.sessionExecutors.get(sessionId);
    if (!executor) return;
    this.sessionExecutors.delete(sessionId);
    await executor.dispose();
  }

  /**
   * Run the executor's Workspace sync and, on completion, emit a
   * `workspace.file_change` event on the session's stream (ADR-0002 §4–§5).
   * The Host is the sole emitter of this event — the Adapter reports tool
   * results only and never emits a workspace/artifact event. The event is
   * persisted to the event log (so reconnecting clients replay it) and
   * published live for the SSE stream's file-tree updates.
   *
   * Nothing is emitted when the sync was a no-op (no sandbox / no changes),
   * so a pure-chat turn produces no file-change noise.
   */
  private async syncWorkspace(
    sessionId: string,
    executor: DisposableToolExecutor,
  ): Promise<void> {
    let result: WorkspaceSyncResult;
    try {
      result = await executor.sync();
    } catch (err) {
      // A sync failure must not fail the turn; surface it as a session error.
      const errorEvent = await this.eventLogStore.append(sessionId, {
        type: "session.error",
        data: { error: { message: String(err), code: "workspace_sync_error" } },
        sessionThreadId: "sthr_primary",
      });
      this.eventStreamHub.publish(sessionId, {
        type: "session.error",
        seq: errorEvent.seq,
        data: { error: { message: String(err), code: "workspace_sync_error" } },
      });
      return;
    }

    if (!syncHasChanges(result)) return;

    const data = {
      workspaceId: result.workspaceId,
      changed: result.changed,
      deleted: result.deleted,
    };
    const stored = await this.eventLogStore.append(sessionId, {
      type: "workspace.file_change",
      data,
      sessionThreadId: "sthr_primary",
    });
    this.eventStreamHub.publish(sessionId, {
      type: "workspace.file_change",
      seq: stored.seq,
      data,
    });
  }

  private async drainLoop(
    sessionId: string,
    agentConfig: Agent,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      // Dequeue next pending event (FIFO, removes from pending collection)
      const pendingEvent = await this.pendingEventStore.dequeue(sessionId);
      if (!pendingEvent) {
        break;
      }

      // Promote: insert user message into canonical event log (correct seq position)
      const promotedEvent = await this.eventLogStore.append(sessionId, {
        type: pendingEvent.type,
        data: pendingEvent.data,
        sessionThreadId: pendingEvent.sessionThreadId,
      });
      this.eventStreamHub.publish(sessionId, {
        type: promotedEvent.type,
        seq: promotedEvent.seq,
        data: promotedEvent.data,
      });

      // The turnId is derived from the promoted user message's seq and is the
      // key for this turn's transient delta stream + active-turn record.
      const turnId = `turn_${promotedEvent.seq}`;

      // Record the active turn in Redis (not process memory) so a reconnecting
      // client — possibly on another Host instance — can find and backfill the
      // in-flight turn's deltas.
      if (this.turnStreamStore) {
        await this.turnStreamStore.setActiveTurn(sessionId, { turnId, status: "running" });
      }

      // Set session status to running
      await this.sessionStore.updateStatus(sessionId, "running");

      // Persist + publish session.status_running
      const runningEvent = await this.eventLogStore.append(sessionId, {
        type: "session.status_running",
        data: {},
        sessionThreadId: "sthr_primary",
      });
      this.eventStreamHub.publish(sessionId, {
        type: "session.status_running",
        seq: runningEvent.seq,
        data: {},
      });

      // Fail-loud (issue #54): a sandboxed Agent with no provisionable executor
      // must NOT run — otherwise the adapter falls back to built-in fs/bash tools
      // that write to the server pod filesystem. Emit a session.error, mark the
      // turn handled (it was already dequeued), and skip the adapter for this turn.
      if (this.isSandboxedButUnprovisionable(agentConfig)) {
        const error = {
          message:
            "Agent is sandboxed but no sandbox executor is available (SANDBOX_ENABLED / E2B config missing)",
          code: "sandbox_unavailable",
        };
        const errorEvent = await this.eventLogStore.append(sessionId, {
          type: "session.error",
          data: { error },
          sessionThreadId: "sthr_primary",
        });
        this.eventStreamHub.publish(sessionId, {
          type: "session.error",
          seq: errorEvent.seq,
          data: { error },
        });
        // Mirror the normal turn-end housekeeping so the transient stream/active
        // turn record don't leak, then move on to the next pending event (the
        // drain loop falls through to the idle transition when the queue empties).
        if (this.turnStreamStore) {
          await this.turnStreamStore.reclaim(turnId);
          await this.turnStreamStore.setActiveTurn(sessionId, { turnId, status: "idle" });
        }
        continue;
      }

      // Build adapter input (include history for multi-turn)
      const { data: priorEvents } = await this.eventLogStore.getEvents(sessionId);

      // Bind the per-session sandbox-backed executor (lazy — no sandbox yet).
      // A pure-chat turn never touches it, so nothing is created.
      const toolExecutor = await this.getExecutorForSession(sessionId, agentConfig);

      // Assemble the Agent's Files into appendSystemPrompt (fixed order,
      // missing skipped) and materialize its equipped Skills to a temp dir.
      // Both are per-turn Host injections (ADR-0002); Skills are cleaned up at
      // turn end regardless of how the turn ends.
      const appendSystemPrompt = await this.assembleAgentFiles(agentConfig);
      const skills = await this.materializeSkills(agentConfig);

      // Resolve the model live from the Agent's *current* config (issue #59 /
      // ADR-0003 §3), not the model snapshotted onto the Session at creation.
      // Only the model is resolved live; all other agentConfig fields keep the
      // snapshot. Because a fresh in-memory Pi session is rebuilt per turn and
      // prior assistant messages carry their own origin provider/api/model, the
      // provider layer normalizes tool-call ids correctly across a model switch.
      const model = await this.resolveCurrentModel(agentConfig);

      const adapterInput = this.buildAdapterInput(
        sessionId,
        turnId,
        promotedEvent,
        agentConfig,
        priorEvents,
        toolExecutor,
        appendSystemPrompt,
        skills.paths,
        model,
      );

      // The Adapter is a pure translator: it runs directly and routes any tool
      // calls through the injected per-run executor (ADR-0002 §1–2). There is
      // no separate sandbox orchestrator — the sandbox lives behind the
      // executor and is invisible to the router and the adapter alike.
      const adapter = this.resolveAdapter(agentConfig.runtime);
      const events = adapter.run(adapterInput);

      // blockIndex increments on each stream_start, aligning a turn's deltas to
      // the full Event they roll up into (shared turnId + blockIndex).
      let blockIndex = -1;

      try {
        for await (const event of events) {
          if (signal.aborted) break;

          if (isStreamEvent(event)) {
            if (STREAM_START_TYPES.has(event.type)) {
              blockIndex++;
            }
            const currentBlock = blockIndex < 0 ? 0 : blockIndex;

            // Transient: token-level deltas go to the per-turn Redis stream for
            // reconnect backfill (never to PostgreSQL), tagged with turnId +
            // blockIndex. The returned Redis entry id lets a reconnecting client
            // dedup live vs. backfilled deltas exactly.
            let deltaId: string | undefined;
            if (this.turnStreamStore) {
              deltaId = await this.turnStreamStore.appendDelta({
                turnId,
                blockIndex: currentBlock,
                type: event.type,
                data: event,
              });
            }

            // Live: publish to in-process subscribers, carrying the same
            // turnId + blockIndex (and the Redis entry id) so live and
            // backfilled frames are identical and can be de-overlapped on
            // reconnect.
            this.eventStreamHub.publishChunk(sessionId, {
              type: event.type,
              data: event,
              turnId,
              blockIndex: currentBlock,
              deltaId,
            });
          } else {
            const stored = await this.eventLogStore.append(sessionId, {
              type: event.type,
              data: event,
              sessionThreadId: "sthr_primary",
            });
            this.eventStreamHub.publish(sessionId, {
              type: event.type,
              seq: stored.seq,
              data: event,
            });
          }
        }
      } catch (err) {
        if (signal.aborted) {
          if (this.turnStreamStore) {
            await this.turnStreamStore.reclaim(turnId);
          }
          // Materialized Skills are per-turn; drop them even on interrupt.
          await skills.cleanup();
          break;
        }
        const errorEvent = await this.eventLogStore.append(sessionId, {
          type: "session.error",
          data: { error: { message: String(err), code: "adapter_error" } },
          sessionThreadId: "sthr_primary",
        });
        this.eventStreamHub.publish(sessionId, {
          type: "session.error",
          seq: errorEvent.seq,
          data: { error: { message: String(err), code: "adapter_error" } },
        });
      }

      // Sync the Workspace back to S3 at this tool-execution point (turn end).
      // Owned by the executor (scan + content-hash push + baseline-diff
      // deletion); the Host emits the resulting file-change event. Pure-chat
      // turns never created a sandbox, so this is a cheap no-op.
      if (toolExecutor) {
        await this.syncWorkspace(sessionId, toolExecutor);
      }

      // Materialized Skills are per-turn scratch — remove the temp dir now that
      // the adapter run has finished (idempotent with the abort-path cleanup).
      await skills.cleanup();

      // The turn's full content is now persisted to PostgreSQL, so the
      // transient delta stream is no longer needed: reclaim it (DEL) and mark
      // the turn idle. This runs on normal completion and on an in-turn
      // interrupt (the for-loop `break` falls through to here).
      if (this.turnStreamStore) {
        await this.turnStreamStore.reclaim(turnId);
        await this.turnStreamStore.setActiveTurn(sessionId, { turnId, status: "idle" });
      }
    }

    // After drain loop ends, clear the active-turn record and set idle.
    if (this.turnStreamStore) {
      await this.turnStreamStore.clearActiveTurn(sessionId);
    }
    await this.sessionStore.updateStatus(sessionId, "idle");

    const idleEvent = await this.eventLogStore.append(sessionId, {
      type: "session.status_idle",
      data: {},
      sessionThreadId: "sthr_primary",
    });
    this.eventStreamHub.publish(sessionId, {
      type: "session.status_idle",
      seq: idleEvent.seq,
      data: {},
    });

    // The session's sandbox (if any was created) is intentionally kept across
    // turns and destroyed only when the session is explicitly terminated, via
    // terminateSession → disposeExecutor.
  }

  /**
   * The model to run this turn on. Resolved from the Agent's **current** config
   * (via {@link agentStore}) so a model change takes effect on existing
   * conversations (issue #59). Falls back to the Session-snapshot model when no
   * agent store is configured or the Agent has since been deleted.
   */
  private async resolveCurrentModel(agentConfig: Agent): Promise<string> {
    if (!this.agentStore) return agentConfig.model;
    const current = await this.agentStore.getById(agentConfig.id);
    return current?.model ?? agentConfig.model;
  }

  private buildAdapterInput(
    sessionId: string,
    turnId: string,
    promotedEvent: StoredEvent,
    agentConfig: Agent,
    priorEvents: StoredEvent[],
    toolExecutor?: ToolExecutor,
    appendSystemPrompt?: string[],
    skillPaths?: string[],
    model: string = agentConfig.model,
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

    const message: UserMessage = {
      role: "user",
      content,
    };

    // History: all events before the current promoted event
    const history = priorEvents
      .filter((e) => e.seq < promotedEvent.seq)
      .map((e) => ({ type: e.type, ...(e.data as object) }) as unknown as SessionEvent);

    return {
      sessionId,
      turnId,
      message,
      agent: {
        model,
        system: agentConfig.system,
        tools: agentConfig.tools,
        mcpServers: agentConfig.mcpServers,
        skills: agentConfig.skills,
        // Per-call Host injections (ADR-0002): assembled Agent Files and
        // materialized equipped-Skill directories. Undefined when their stores
        // are absent, preserving prior behavior.
        appendSystemPrompt: appendSystemPrompt && appendSystemPrompt.length > 0
          ? appendSystemPrompt
          : undefined,
        skillPaths: skillPaths && skillPaths.length > 0 ? skillPaths : undefined,
      },
      history,
      // Per-call injection: the single seam between the pure Adapter and infra.
      toolExecutor,
    };
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
   * Materialize the Agent's equipped Skills (`agentConfig.skills` = skillIds)
   * from S3 into a fresh Host-side temp directory — one subdirectory per Skill,
   * each a valid skill root (SKILL.md at its top) — and return their absolute
   * paths plus an idempotent cleanup. Returns no paths (and a no-op cleanup)
   * when the Skill stores are absent or the Agent has no equipped Skills.
   */
  private async materializeSkills(
    agentConfig: Agent,
  ): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
    const noop = { paths: [] as string[], cleanup: async () => {} };
    const skillIds = agentConfig.skills ?? [];
    if (!this.skillStore || !this.skillArtifactStore || skillIds.length === 0) {
      return noop;
    }

    const root = await mkdtemp(join(tmpdir(), "oma-skills-"));
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      await rm(root, { recursive: true, force: true });
    };

    try {
      const paths: string[] = [];
      for (const skillId of skillIds) {
        // Only materialize Skills the Agent's tenant actually owns.
        const skill = await this.skillStore.getById(skillId);
        if (!skill || skill.tenantId !== agentConfig.tenantId) continue;
        const files = await this.skillArtifactStore.getAll(agentConfig.tenantId, skillId);
        if (files.length === 0) continue;
        const skillDir = join(root, skillId);
        for (const file of files) {
          const dest = join(skillDir, file.path);
          await mkdir(dirname(dest), { recursive: true });
          await writeFile(dest, file.body);
        }
        paths.push(skillDir);
      }
      return { paths, cleanup };
    } catch (err) {
      await cleanup();
      throw err;
    }
  }
}
