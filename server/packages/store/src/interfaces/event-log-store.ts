import type { PaginatedResult, StoredEvent } from "../types.js";

export interface EventLogStoreGetEventsOpts {
  afterSeq?: number;
  limit?: number;
}

export interface EventLogStoreAppendInput {
  type: string;
  data: unknown;
  sessionThreadId: string;
}

export interface EventLogStore {
  append(sessionId: string, event: EventLogStoreAppendInput): Promise<StoredEvent>;
  getEvents(sessionId: string, opts?: EventLogStoreGetEventsOpts): Promise<PaginatedResult<StoredEvent>>;
}
