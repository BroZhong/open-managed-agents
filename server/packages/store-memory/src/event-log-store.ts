import type {
  StoredEvent,
  EventLogIngressStore,
  EventLogStoreAppendInput,
  EventLogStoreGetEventsOpts,
  PaginatedResult,
  PendingEventFence,
} from "@oma-server/store";
import { PendingEventClaimLostError } from "@oma-server/store";

export class InMemoryEventLogStore implements EventLogIngressStore {
  private events: Map<string, StoredEvent[]> = new Map();
  private seqCounters: Map<string, number> = new Map();
  private idempotentEvents: Map<string, StoredEvent> = new Map();

  constructor(
    private readonly validateFence?: (
      sessionId: string,
      fence: PendingEventFence,
    ) => Promise<boolean>,
    private readonly isSessionActive: (sessionId: string) => Promise<boolean> = async () => true,
  ) {}

  async append(sessionId: string, event: EventLogStoreAppendInput): Promise<StoredEvent> {
    if (
      event.pendingFence &&
      this.validateFence &&
      !await this.validateFence(sessionId, event.pendingFence)
    ) {
      throw new PendingEventClaimLostError(
        sessionId,
        event.pendingFence.eventId,
        event.pendingFence.ownerId,
        event.pendingFence.generation,
      );
    }
    const idempotencyIdentity = event.idempotencyKey === undefined
      ? undefined
      : `${sessionId}\u0000${event.idempotencyKey}`;
    if (idempotencyIdentity !== undefined) {
      const existing = this.idempotentEvents.get(idempotencyIdentity);
      if (existing) return existing;
    }

    const currentSeq = this.seqCounters.get(sessionId) ?? 0;
    const nextSeq = currentSeq + 1;
    this.seqCounters.set(sessionId, nextSeq);

    const stored: StoredEvent = {
      sessionId,
      seq: nextSeq,
      type: event.type,
      data: event.data,
      ts: new Date(),
      sessionThreadId: event.sessionThreadId,
    };

    const sessionEvents = this.events.get(sessionId) ?? [];
    sessionEvents.push(stored);
    this.events.set(sessionId, sessionEvents);
    if (idempotencyIdentity !== undefined) {
      this.idempotentEvents.set(idempotencyIdentity, stored);
    }

    return stored;
  }

  async appendIfSessionActive(
    sessionId: string,
    event: Pick<EventLogStoreAppendInput, "type" | "data" | "sessionThreadId">,
  ): Promise<StoredEvent | null> {
    if (!await this.isSessionActive(sessionId)) return null;
    return this.append(sessionId, event);
  }

  async getEvents(
    sessionId: string,
    opts?: EventLogStoreGetEventsOpts,
  ): Promise<PaginatedResult<StoredEvent>> {
    const allEvents = this.events.get(sessionId) ?? [];
    const afterSeq = opts?.afterSeq ?? 0;
    const limit = opts?.limit ?? 50;

    const filtered = allEvents.filter((e) => e.seq > afterSeq);
    const data = filtered.slice(0, limit);
    const hasMore = filtered.length > limit;

    return { data, hasMore };
  }
}
