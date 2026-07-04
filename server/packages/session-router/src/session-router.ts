import type { EventLogStore, PendingEventStore, PendingEvent, StoredEvent, Agent } from "@oma-server/store";
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

  private isSandboxed(agentConfig: Agent): boolean {
    return !!agentConfig.sandbox?.enabled;
  }

  /**
   * Get (or lazily construct) this session's sandbox-backed executor. The
   * executor object itself does not create a sandbox — that happens lazily on
   * its first filesystem/code call — so obtaining it here is cheap and does
   * not spin anything up for a pure-chat turn.
   */
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

      // Build adapter input (include history for multi-turn)
      const { data: priorEvents } = await this.eventLogStore.getEvents(sessionId);

      // Bind the per-session sandbox-backed executor (lazy — no sandbox yet).
      // A pure-chat turn never touches it, so nothing is created.
      const toolExecutor = await this.getExecutorForSession(sessionId, agentConfig);

      const adapterInput = this.buildAdapterInput(
        sessionId,
        turnId,
        promotedEvent,
        agentConfig,
        priorEvents,
        toolExecutor,
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

  private buildAdapterInput(
    sessionId: string,
    turnId: string,
    promotedEvent: StoredEvent,
    agentConfig: Agent,
    priorEvents: StoredEvent[],
    toolExecutor?: ToolExecutor,
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
        model: agentConfig.model,
        system: agentConfig.system,
        tools: agentConfig.tools,
        mcpServers: agentConfig.mcpServers,
        skills: agentConfig.skills,
      },
      history,
      // Per-call injection: the single seam between the pure Adapter and infra.
      toolExecutor,
    };
  }
}
