import type { EventLogStore, PendingEventStore, PendingEvent, StoredEvent, Agent } from "@oma-server/store";
import type { SessionStore } from "@oma-server/store";
import type { EventStreamHub } from "@oma-server/event-log";
import type { SandboxOrchestrator } from "@oma-server/sandbox";
import type {
  Adapter,
  AdapterInput,
  SessionEvent,
  ContentBlock,
  UserMessage,
} from "@open-managed-agents/adapter-core";
import { isStreamEvent } from "@open-managed-agents/adapter-core";

export interface SessionRouterDeps {
  eventLogStore: EventLogStore;
  pendingEventStore: PendingEventStore;
  sessionStore: SessionStore;
  eventStreamHub: EventStreamHub;
  resolveAdapter: (runtime: string) => Adapter;
  sandboxOrchestrator?: SandboxOrchestrator;
}

export class SessionRouter {
  private readonly eventLogStore: EventLogStore;
  private readonly pendingEventStore: PendingEventStore;
  private readonly sessionStore: SessionStore;
  private readonly eventStreamHub: EventStreamHub;
  private readonly resolveAdapter: (runtime: string) => Adapter;
  private readonly sandboxOrchestrator?: SandboxOrchestrator;
  private readonly activeSessions = new Map<string, AbortController>();
  private readonly activeSandboxes = new Set<string>();

  constructor(deps: SessionRouterDeps) {
    this.eventLogStore = deps.eventLogStore;
    this.pendingEventStore = deps.pendingEventStore;
    this.sessionStore = deps.sessionStore;
    this.eventStreamHub = deps.eventStreamHub;
    this.resolveAdapter = deps.resolveAdapter;
    this.sandboxOrchestrator = deps.sandboxOrchestrator;
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

  private isSandboxed(agentConfig: Agent): boolean {
    return !!agentConfig.sandbox?.enabled;
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
      const adapterInput = this.buildAdapterInput(
        sessionId,
        promotedEvent,
        agentConfig,
        priorEvents,
      );

      // Determine event source: sandbox orchestrator or direct adapter
      let events: AsyncIterable<SessionEvent>;
      if (this.sandboxOrchestrator && this.isSandboxed(agentConfig)) {
        if (!this.activeSandboxes.has(sessionId)) {
          await this.sandboxOrchestrator.createForSession(sessionId, {
            image: agentConfig.sandbox?.image,
          });
          this.activeSandboxes.add(sessionId);
        } else {
          await this.sandboxOrchestrator.resume(sessionId);
        }
        events = this.sandboxOrchestrator.runAdapterTurn(sessionId, adapterInput);
      } else {
        const adapter = this.resolveAdapter(agentConfig.runtime);
        events = adapter.run(adapterInput);
      }

      try {
        for await (const event of events) {
          if (signal.aborted) break;

          if (isStreamEvent(event)) {
            this.eventStreamHub.publishChunk(sessionId, {
              type: event.type,
              data: event,
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
        if (signal.aborted) break;
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

      // After turn completes, pause sandbox if active
      if (this.sandboxOrchestrator && this.isSandboxed(agentConfig)) {
        await this.sandboxOrchestrator.pause(sessionId);
      }
    }

    // After drain loop ends, set session status to idle
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

    // Kill sandbox when session ends
    if (this.sandboxOrchestrator && this.isSandboxed(agentConfig) && this.activeSandboxes.has(sessionId)) {
      await this.sandboxOrchestrator.kill(sessionId);
      this.activeSandboxes.delete(sessionId);
    }
  }

  private buildAdapterInput(
    sessionId: string,
    promotedEvent: StoredEvent,
    agentConfig: Agent,
    priorEvents: StoredEvent[],
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
      turnId: `turn_${promotedEvent.seq}`,
      message,
      agent: {
        model: agentConfig.model,
        system: agentConfig.system,
        tools: agentConfig.tools,
        mcpServers: agentConfig.mcpServers,
        skills: agentConfig.skills,
      },
      history,
    };
  }
}
