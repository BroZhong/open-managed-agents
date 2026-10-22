import type {
  StoredEvent,
  EventLogIngressStore,
  EventLogStoreAppendInput,
  EventLogStoreGetEventsOpts,
  EventLogUsageScope,
  PaginatedResult,
  PendingEventFence,
  TokenUsageSummary,
} from "@oma-server/store";
import {
  PendingEventClaimLostError,
  lazyEventData,
  eventSequenceWidth,
  summarizeTokenUsage,
} from "@oma-server/store";

const idempotencyIdentity = (sessionId: string, idempotencyKey: string) => `${sessionId}\u0000${idempotencyKey}`;

export class InMemoryEventLogStore implements EventLogIngressStore {
  async getLatestSeq(sessionId: string): Promise<number> {
    return this.seqCounters.get(sessionId) ?? 0;
  }
  /** Canonical in-memory log record; attribution stays internal to the store. */
  private events: Map<
    string,
    Array<{ event: StoredEvent; apiKeyId?: string }>
  > = new Map();
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
    return this.appendUnfenced(sessionId, event);
  }

  /**
   * {@link append} for the in-memory delegation transaction, which also says
   * whether the event is new: an idempotent retry returns an existing one,
   * which a rollback must keep. {@link removeAdded} takes back one it added.
   * `append` does not call this: an extra await on every append shifts the
   * interleavings the crash-injection sweeps check.
   */
  async appendRecorded(sessionId: string, event: EventLogStoreAppendInput): Promise<{ event: StoredEvent; added: boolean }> {
    if (event.pendingFence && this.validateFence && !await this.validateFence(sessionId, event.pendingFence)) {
      throw new PendingEventClaimLostError(sessionId, event.pendingFence.eventId, event.pendingFence.ownerId, event.pendingFence.generation);
    }
    return this.insert(sessionId, event);
  }

  /** Internal synchronous write for a composed in-memory transaction. */
  appendUnfenced(sessionId: string, event: Omit<EventLogStoreAppendInput, "pendingFence">): StoredEvent {
    return this.insert(sessionId, event).event;
  }

  /**
   * Takes back an event {@link appendRecorded} added. Its sequence number is
   * not reused: another writer may have read the event or appended after it.
   */
  removeAdded(event: StoredEvent, idempotencyKey?: string): void {
    const records = this.events.get(event.sessionId) ?? [];
    const index = records.findIndex((record) => record.event.seq === event.seq);
    if (index >= 0) records.splice(index, 1);
    if (idempotencyKey !== undefined) this.idempotentEvents.delete(idempotencyIdentity(event.sessionId, idempotencyKey));
  }

  private insert(sessionId: string, event: Omit<EventLogStoreAppendInput, "pendingFence">): { event: StoredEvent; added: boolean } {
    const identity = event.idempotencyKey === undefined
      ? undefined
      : idempotencyIdentity(sessionId, event.idempotencyKey);
    if (identity !== undefined) {
      const existing = this.idempotentEvents.get(identity);
      if (existing) return { event: existing, added: false };
    }

    const currentSeq = this.seqCounters.get(sessionId) ?? 0;
    const nextSeq = currentSeq + eventSequenceWidth(event.type, event.data);
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
    sessionEvents.push({
      event: stored,
      ...(event.apiKeyId ? { apiKeyId: event.apiKeyId } : {}),
    });
    this.events.set(sessionId, sessionEvents);
    if (identity !== undefined) {
      this.idempotentEvents.set(identity, stored);
    }

    return { event: stored, added: true };
  }

  /** Internal lookup for the completed-input acknowledgement transaction. */
  hasTurnCompletion(sessionId: string, eventId: string): boolean {
    return this.idempotentEvents.get(`${sessionId}\u0000pending:${eventId}:completed`)?.type === "session.turn_completed";
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

    const filtered = allEvents.filter(({ event }) => event.seq > afterSeq && (!opts?.turnId || (event.data as { turnId?: string } | undefined)?.turnId === opts.turnId));
    const data = filtered.slice(0, limit);
    const hasMore = filtered.length > limit;

    return { data: data.map(({ event }) => opts?.payload === "reference" ? { ...event, data: lazyEventData(event.type, event.data) } : event), hasMore };
  }

  async getUsage(scope: EventLogUsageScope): Promise<TokenUsageSummary> {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    const count = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

    const records = "sessionId" in scope
      ? this.events.get(scope.sessionId) ?? []
      : [...this.events.values()]
          .flat()
          .filter((record) => "callerSessionId" in scope
            ? (record.event.data as { callerSessionId?: string } | undefined)?.callerSessionId === scope.callerSessionId
            : record.apiKeyId === scope.apiKeyId);

    for (const { event } of records) {
      if (event.type !== "span.model_request_end") continue;
      if ("sessionId" in scope && scope.turnId && (event.data as { turnId?: string } | undefined)?.turnId !== scope.turnId) continue;
      const data = event.data && typeof event.data === "object"
        ? event.data as { usage?: Record<string, unknown> }
        : undefined;
      inputTokens += count(data?.usage?.inputTokens);
      outputTokens += count(data?.usage?.outputTokens);
      cacheReadTokens += count(data?.usage?.cacheReadTokens);
      cacheWriteTokens += count(data?.usage?.cacheWriteTokens);
    }

    return summarizeTokenUsage({
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    });
  }

  async getUsageByApiKeyIds(apiKeyIds: string[]): Promise<Map<string, TokenUsageSummary>> {
    const result = new Map<string, TokenUsageSummary>();
    for (const apiKeyId of new Set(apiKeyIds)) {
      result.set(apiKeyId, await this.getUsage({ apiKeyId }));
    }
    return result;
  }

}
