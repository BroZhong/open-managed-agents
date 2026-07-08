import type {
  EventLogStore,
  PendingEventStore,
  StoredEvent,
  Agent,
  AgentFileStore,
  AgentStore,
  Session,
  SkillStore,
  SkillArtifactStore,
} from "@oma-server/store";
import type { SessionStore } from "@oma-server/store";
import type { EventStreamHub } from "@oma-server/event-log";
import type { TurnStreamStore } from "@oma-server/redis";
import type {
  EnvSpec,
  SandboxManager,
  SandboxSession,
  SyncResult,
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
   * The single owner of sandbox lifecycle (ADR-0005 §1, design doc §2/§6).
   * When present and the agent is sandboxed, the router `open`s exactly one
   * {@link SandboxSession} per Session (cheap — lazy, no sandbox is started
   * until the first tool call), injects it as the per-run {@link ToolExecutor},
   * `checkpoint`s it at each turn end, and `dispose`s it — destroying the
   * sandbox — at session end. Absent ⇒ a sandboxed agent fails loud (see
   * {@link isSandboxedButUnprovisionable}); an opted-out agent runs with no
   * injected executor (its own tool execution, no sandbox).
   *
   * Replaces the old `toolExecutorFactory` + per-session executor Map: the
   * SandboxSession owns its own lifecycle and self-heal, so the router keeps
   * only a lookup Map (`sessions`) and never a lifecycle registry.
   */
  sandboxManager?: SandboxManager;
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
   * router selects the Agent's *equipped* Skills that are valid (exist, in this
   * tenant, owned by this Agent when `ownerType==='agent'`, and non-empty) and
   * declares each as a **Read-only Projection** into the sandbox at
   * `/skills/<id>` (ADR-0005 §4). The Skill *content* flows S3→sandbox inside
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
  private readonly sandboxManager?: SandboxManager;
  private readonly agentFileStore?: AgentFileStore;
  private readonly agentStore?: AgentStore;
  private readonly skillStore?: SkillStore;
  private readonly skillArtifactStore?: SkillArtifactStore;
  private readonly turnStreamStore?: TurnStreamStore;
  private readonly activeSessions = new Map<string, AbortController>();
  /**
   * One {@link SandboxSession} per session, reused across turns. This is a
   * **lookup** map, NOT a lifecycle registry: the SandboxSession owns its own
   * lifecycle (lazy create on first primitive, transparent self-heal after a
   * gateway reclaim, sync-before-destroy on dispose). The router only remembers
   * *which* session belongs to a sessionId so the same long-lived binding is
   * reused turn after turn and disposed exactly once at session end. Each entry
   * is a distinct session bound to that Session's EnvSpec — never shared across
   * Sessions.
   */
  private readonly sessions = new Map<string, SandboxSession>();

  constructor(deps: SessionRouterDeps) {
    this.eventLogStore = deps.eventLogStore;
    this.pendingEventStore = deps.pendingEventStore;
    this.sessionStore = deps.sessionStore;
    this.eventStreamHub = deps.eventStreamHub;
    this.resolveAdapter = deps.resolveAdapter;
    this.sandboxManager = deps.sandboxManager;
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
   * was ever created). `SandboxSession.dispose` syncs the last turn's files THEN
   * tears the sandbox down (ADR-0005 §5, design doc §3), returning the final
   * delta; a pure-chat session that never created a sandbox disposes to an empty
   * no-op. We drop the lookup entry first so a concurrent turn can't reuse a
   * disposing session, then emit any final file-change so the tree reflects the
   * last turn's writes.
   */
  async terminateSession(sessionId: string): Promise<void> {
    this.interrupt(sessionId);
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (session) {
      const result = await session.dispose();
      if (syncHasChanges(result)) this.emitFileChange(sessionId, result);
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
   * Projection at `/skills/<id>` (outside `/workspace`, so the workspace sync
   * never writes it back — the invariant the manager fail-loud asserts).
   *
   * `equippedSkillIds` is precomputed by the caller (it needs async store
   * lookups for ownership + non-empty validation), so `specFor` stays a pure
   * value builder. The projection `source` is the weak-typed coordinate the
   * `S3ProvisionSource` (registered under `kind: "s3"` in the manager's deps)
   * reads: `{ tenantId, skillId }` maps straight onto
   * `SkillArtifactStore.getAll` inside the manager (see `S3ProvisionRef`).
   */
  private specFor(
    session: Session,
    agent: Agent,
    equippedSkillIds: string[],
  ): EnvSpec {
    return {
      tenantId: session.tenantId,
      workspaceId: session.workspaceId,
      image: agent.sandbox?.image,
      env: agent.sandbox?.env,
      projections: equippedSkillIds.map((id) => ({
        targetPath: `/skills/${id}`,
        source: { kind: "s3", ref: { tenantId: session.tenantId, skillId: id } },
      })),
    };
  }

  /**
   * Get (or lazily open) this session's {@link SandboxSession} (design doc §6).
   * `open` is **cheap** — it starts no sandbox; the first filesystem/code
   * primitive triggers create+hydrate+project — so obtaining it here spins
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
    equippedSkillIds: string[],
  ): SandboxSession | undefined {
    if (!this.sandboxManager || !this.isSandboxed(agent)) return undefined;
    let sandbox = this.sessions.get(sessionId);
    if (!sandbox) {
      sandbox = this.sandboxManager.open(this.specFor(session, agent, equippedSkillIds));
      this.sessions.set(sessionId, sandbox);
    }
    return sandbox; // lazy: no sandbox actually started yet.
  }

  /**
   * Append + publish a `workspace.file_change` for a non-empty sync delta
   * (ADR-0002 §4–§5, ADR-0005 §5). The Host is the sole emitter of this event —
   * the SandboxManager/SandboxSession only *returns* a {@link SyncResult}; the
   * Adapter reports tool results only and never emits a workspace/artifact
   * event. The event is persisted to the event log (so reconnecting clients
   * replay it) and published live for the SSE stream's file-tree updates. The
   * caller guards with {@link syncHasChanges}, so this is only reached when there
   * is a change to broadcast — a pure-chat turn produces no file-change noise.
   */
  private async emitFileChange(
    sessionId: string,
    result: SyncResult,
  ): Promise<void> {
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

  /**
   * Run the session's turn-end checkpoint sync and, when it produced changes,
   * emit the `workspace.file_change` event (ADR-0005 §5). Owned by the
   * SandboxSession (scan + content-hash push + baseline-diff deletion, inside
   * the injected `WorkspacePersistence`); the Host only broadcasts the delta.
   *
   * A checkpoint of a session that never created a sandbox (pure chat) or whose
   * sandbox was reclaimed returns an empty result and never throws (design doc
   * §3). A *genuine* medium failure DOES throw — we lift the old `syncWorkspace`
   * try/catch that turns such a failure into a `session.error`
   * (`workspace_sync_error`) rather than failing the turn.
   */
  private async checkpointWorkspace(
    sessionId: string,
    sandbox: SandboxSession,
  ): Promise<void> {
    let result: SyncResult;
    try {
      result = await sandbox.checkpoint();
    } catch (err) {
      // A sync failure must not fail the turn; surface it as a session error.
      const error = { message: String(err), code: "workspace_sync_error" };
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
      return;
    }

    if (syncHasChanges(result)) await this.emitFileChange(sessionId, result);
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

      // Fail-loud (issue #54): a sandboxed Agent with no provisionable manager
      // must NOT run — otherwise the adapter falls back to built-in fs/bash tools
      // that write to the server pod filesystem. Emit a session.error, mark the
      // turn handled (it was already dequeued), and skip the adapter for this turn.
      if (this.isSandboxedButUnprovisionable(agentConfig)) {
        const error = {
          message:
            "Agent is sandboxed but no sandbox manager is available (SANDBOX_ENABLED / E2B config missing)",
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

      // Select the Agent's valid equipped-Skill ids up front — the async store
      // validation feeds BOTH the EnvSpec projections (via `sandboxFor`) and the
      // in-sandbox `skillPaths` handed to the adapter, so the two never diverge.
      const equippedSkillIds = await this.equippedSkillIds(agentConfig);

      // Bind the per-session SandboxSession (lazy — no sandbox yet). A pure-chat
      // turn never touches it, so nothing is created. Needs the Session record
      // for its tenant/workspace binding.
      const session = await this.sessionStore.getById(sessionId);
      if (!session) {
        throw new Error(`Cannot run turn: session ${sessionId} not found`);
      }
      const sandbox = this.sandboxFor(sessionId, session, agentConfig, equippedSkillIds);

      // Assemble the Agent's Files into appendSystemPrompt (fixed order, missing
      // skipped). Skills are no longer materialized to a Host temp dir — they are
      // projected into the sandbox by the SandboxManager (ADR-0005 §4); the
      // adapter is pointed at their in-sandbox `/skills/<id>` roots below.
      const appendSystemPrompt = await this.assembleAgentFiles(agentConfig);
      const skillPaths = equippedSkillIds.map((id) => `/skills/${id}`);

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
        sandbox,
        appendSystemPrompt,
        skillPaths,
        model,
      );

      // The Adapter is a pure translator: it runs directly and routes any tool
      // calls through the injected SandboxSession (ADR-0002 §1–2, ADR-0005 §1).
      // There is no separate sandbox orchestrator — the sandbox lives behind the
      // session and is invisible to the router and the adapter alike.
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

      // Turn-end lifecycle checkpoint (ADR-0005 §5): sync the sandbox Workspace
      // back through the persistence seam and emit the resulting file-change
      // event. Owned by the SandboxSession; a pure-chat turn never created a
      // sandbox, so this is a cheap empty no-op.
      if (sandbox) {
        await this.checkpointWorkspace(sessionId, sandbox);
      }

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
    // terminateSession → SandboxSession.dispose.
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
        // Per-call Host injections (ADR-0002): assembled Agent Files and the
        // in-sandbox roots of equipped Skills. `skillPaths` are `/skills/<id>`
        // paths *inside the sandbox* (ADR-0005 §4) — the adapter points Pi's
        // sandbox-mapped read tool at them (SKILL.md at `/skills/<id>/SKILL.md`).
        // Undefined when their stores are absent, preserving prior behavior.
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
   * Select the ids of the Agent's equipped Skills that should be projected into
   * the sandbox as Read-only Projections at `/skills/<id>` (ADR-0005 §4). This
   * is the *validation* half of the old `materializeSkills`, minus the Host
   * temp-dir write: it decides WHICH Skill ids become projections; the *content*
   * flows S3→sandbox inside the SandboxManager (`S3ProvisionSource`), never
   * through the Host.
   *
   * Preserved behavior, id-for-id, from `materializeSkills`:
   *  - No Skill stores or no equipped Skills ⇒ no ids (no projections).
   *  - A Skill is skipped unless it exists, is in this tenant, and — for
   *    `ownerType==='agent'` — is owned by this Agent. Per ADR-0004
   *    `agent.skills` holds the Agent's own Skill Fork ids, which always exist
   *    while equipped; we still guard on ownership defensively.
   *  - A Skill with **zero files** is skipped (the old zero-files skip). We
   *    confirm non-empty with `skillArtifactStore.list` (paths only) rather than
   *    `getAll` (bodies) — the bodies are the manager's job now, so the router
   *    reads only enough to make the include/skip decision.
   */
  private async equippedSkillIds(agentConfig: Agent): Promise<string[]> {
    const skillIds = agentConfig.skills ?? [];
    if (!this.skillStore || !this.skillArtifactStore || skillIds.length === 0) {
      return [];
    }

    const valid: string[] = [];
    for (const skillId of skillIds) {
      // Only project the Agent's own forks (owned by this Agent, in this
      // tenant). Anything else (missing, cross-tenant, or a stale Library id
      // from pre-fork data) is skipped rather than trusted.
      const skill = await this.skillStore.getById(skillId);
      if (
        !skill ||
        skill.tenantId !== agentConfig.tenantId ||
        (skill.ownerType === "agent" && skill.ownerId !== agentConfig.id)
      ) {
        continue;
      }
      // Confirm the Skill is non-empty (zero-files skip, preserved from
      // materializeSkills). `list` reads only paths — the bytes are projected
      // S3→sandbox by the manager, so the router never touches Skill content.
      const files = await this.skillArtifactStore.list(agentConfig.tenantId, skillId);
      if (files.length === 0) continue;
      valid.push(skillId);
    }
    return valid;
  }
}
