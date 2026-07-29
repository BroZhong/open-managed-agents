export interface PendingEvent {
  id: string;
  sessionId: string;
  type: string;
  data: unknown;
  sessionThreadId: string;
  arrivedAt: Date;
}

export interface PendingEventEnqueueInput {
  type: string;
  data: unknown;
  sessionThreadId: string;
}

/**
 * Monotonic ownership token for one execution attempt of a retained input.
 * The generation changes whenever an expired/released head is claimed again,
 * even by the same Host process, so delayed work from an older attempt cannot
 * renew, acknowledge, or commit on behalf of the new attempt.
 */
export interface PendingEventClaimRef {
  ownerId: string;
  generation: number;
}

export interface PendingEventClaim extends PendingEventClaimRef {
  event: PendingEvent;
  expiresAt: Date;
}

export interface PendingEventFence extends PendingEventClaimRef {
  eventId: string;
}

export interface PendingEventStore {
  enqueue(sessionId: string, event: PendingEventEnqueueInput): Promise<PendingEvent>;
  /** @deprecated Runtime drainers must use claim + fenced ack. */
  dequeue(sessionId: string): Promise<PendingEvent | null>;
  peek(sessionId: string): Promise<PendingEvent | null>;
  /**
   * Atomically claim the FIFO head. A competing live claim returns null. An
   * expired claim starts a new monotonically fenced generation.
   */
  claim?(sessionId: string, ownerId: string, leaseMs: number): Promise<PendingEventClaim | null>;
  /** Extend only the exact, still-live owner+generation lease. */
  renewClaim?(
    sessionId: string,
    eventId: string,
    claim: PendingEventClaimRef,
    leaseMs: number,
  ): Promise<boolean>;
  /** Read-only live-fence check, primarily for external checkpoint gates. */
  ownsClaim?(
    sessionId: string,
    eventId: string,
    claim: PendingEventClaimRef,
  ): Promise<boolean>;
  /** Relinquish only the exact owner+generation claim. */
  releaseClaim?(
    sessionId: string,
    eventId: string,
    claim: PendingEventClaimRef,
  ): Promise<boolean>;
  /**
   * Remove the FIFO head. A claimed row requires the exact, unexpired fence;
   * omitting claim is retained only for unclaimed legacy/test callers.
   */
  ack(sessionId: string, eventId: string, claim?: PendingEventClaimRef): Promise<boolean>;
  /** Session ids whose FIFO queues currently contain at least one event. */
  listPendingSessionIds(): Promise<string[]>;
  /** Discard every pending event for one Session (missing/terminated cleanup). */
  clear(sessionId: string): Promise<void>;
  count(sessionId: string): Promise<number>;
  /**
   * The FIFO entries no live execution attempt holds — input the user is still
   * *waiting* on, as opposed to the head a Turn is executing right now.
   *
   * This is deliberately narrower than {@link count}: a claimed head has already
   * been promoted into the Session's event log, so it is visible as history and
   * must not also be reported as queued.
   *
   * An expired claim counts as waiting again. That is not merely consistency
   * with {@link claim}'s re-claim predicate — it is the honest answer. A lapsed
   * lease means the attempt that held it lost ownership and its Turn is being
   * torn down, so that input really is waiting to be executed by whoever claims
   * it next.
   *
   * Optional for the same reason as {@link claim}: narrow single-process test
   * doubles need not implement it, and callers fall back to {@link count}.
   */
  listUnclaimed?(sessionId: string, limit: number): Promise<PendingEvent[]>;
}

/**
 * Pending-input ingress used by the HTTP API. Unlike the lower-level
 * `enqueue`, this operation serializes with Session termination and commits an
 * entire request batch atomically. A null result means the Session no longer
 * accepts input (missing or terminated); no event from the batch was written.
 */
export interface PendingEventIngressStore extends PendingEventStore {
  enqueueBatchIfSessionActive(
    sessionId: string,
    events: PendingEventEnqueueInput[],
  ): Promise<PendingEvent[] | null>;
}
