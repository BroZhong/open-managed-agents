import type { PaginatedResult, StoredEvent, TokenUsageSummary } from "../types.js";
import type { PendingEventFence } from "./pending-event-store.js";

export interface EventLogStoreGetEventsOpts {
  afterSeq?: number;
  limit?: number;
}

export interface EventLogStoreAppendInput {
  type: string;
  data: unknown;
  sessionThreadId: string;
  /** API key that accepted the Turn input; absent for User session tokens. */
  apiKeyId?: string;
  /**
   * Optional caller-stable identity for an at-least-once append. Repeating an
   * append with the same key in one Session returns the original Stored Event
   * instead of allocating a second sequence number.
   */
  idempotencyKey?: string;
  /**
   * Require this live PG pending claim in the same transaction as the append.
   * A stale owner/generation must never be allowed to persist turn output.
   */
  pendingFence?: PendingEventFence;
}

export type EventLogUsageScope =
  | { sessionId: string }
  | { apiKeyId: string };

export interface EventLogStore {
  append(sessionId: string, event: EventLogStoreAppendInput): Promise<StoredEvent>;
  getEvents(sessionId: string, opts?: EventLogStoreGetEventsOpts): Promise<PaginatedResult<StoredEvent>>;
  getUsage(scope: EventLogUsageScope): Promise<TokenUsageSummary>;
  /** Bulk query used by API-key listings to avoid one query per key. */
  getUsageByApiKeyIds(apiKeyIds: string[]): Promise<Map<string, TokenUsageSummary>>;
}

/** HTTP ingress for direct (non-pending) user Events. */
export interface EventLogIngressStore extends EventLogStore {
  /**
   * Serialize one direct append with Session termination. A null result means
   * the Session is missing/terminated and no sequence number was consumed.
   */
  appendIfSessionActive(
    sessionId: string,
    event: Pick<EventLogStoreAppendInput, "type" | "data" | "sessionThreadId">,
  ): Promise<StoredEvent | null>;
}
