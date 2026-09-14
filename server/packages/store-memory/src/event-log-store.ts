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
  summarizeTokenUsage,
} from "@oma-server/store";

export class InMemoryEventLogStore implements EventLogIngressStore {
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
    sessionEvents.push({
      event: stored,
      ...(event.apiKeyId ? { apiKeyId: event.apiKeyId } : {}),
    });
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

    const filtered = allEvents.filter(({ event }) => event.seq > afterSeq);
    const data = filtered.slice(0, limit);
    const hasMore = filtered.length > limit;

    return { data: data.map(({ event }) => event), hasMore };
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
          .filter((record) => record.apiKeyId === scope.apiKeyId);

    for (const { event } of records) {
      if (event.type !== "span.model_request_end") continue;
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
