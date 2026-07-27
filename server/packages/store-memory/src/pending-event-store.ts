import type {
  PendingEvent,
  PendingEventClaim,
  PendingEventClaimRef,
  PendingEventStore,
  PendingEventIngressStore,
  PendingEventEnqueueInput,
} from "@oma-server/store";

interface ClaimState {
  ownerId?: string;
  generation: number;
  expiresAtMs: number;
}

export class InMemoryPendingEventStore implements PendingEventIngressStore {
  private queues: Map<string, PendingEvent[]> = new Map();
  private claims: Map<string, ClaimState> = new Map();
  private nextId = 1;

  constructor(
    private readonly isSessionActive: (sessionId: string) => Promise<boolean> = async () => true,
  ) {}

  async enqueue(sessionId: string, event: PendingEventEnqueueInput): Promise<PendingEvent> {
    const pending: PendingEvent = {
      id: event.id ?? `pending_${this.nextId++}`,
      sessionId,
      type: event.type,
      data: event.data,
      sessionThreadId: event.sessionThreadId,
      ...(event.apiKeyId ? { apiKeyId: event.apiKeyId } : {}),
      arrivedAt: new Date(),
    };
    const queue = this.queues.get(sessionId) ?? [];
    queue.push(pending);
    this.queues.set(sessionId, queue);
    return pending;
  }

  async enqueueBatchIfSessionActive(
    sessionId: string,
    events: PendingEventEnqueueInput[],
  ): Promise<PendingEvent[] | null> {
    if (!await this.isSessionActive(sessionId)) return null;
    // This store is process-local and enqueue has no asynchronous boundary, so
    // the batch is indivisible with respect to its Session validator.
    const inserted: PendingEvent[] = [];
    for (const event of events) inserted.push(await this.enqueue(sessionId, event));
    return inserted;
  }

  async dequeue(sessionId: string): Promise<PendingEvent | null> {
    const queue = this.queues.get(sessionId) ?? [];
    if (queue.length === 0) return null;
    const head = queue[0]!;
    if (this.claims.get(head.id)?.ownerId) return null;
    queue.shift();
    this.claims.delete(head.id);
    return head;
  }

  async peek(sessionId: string): Promise<PendingEvent | null> {
    const queue = this.queues.get(sessionId) ?? [];
    return queue[0] ?? null;
  }

  async claim(sessionId: string, ownerId: string, leaseMs: number): Promise<PendingEventClaim | null> {
    if (!ownerId) throw new RangeError("pending event ownerId must not be empty");
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new RangeError("pending event leaseMs must be a positive finite number");
    }
    const event = (this.queues.get(sessionId) ?? [])[0];
    if (!event) return null;
    const now = Date.now();
    const current = this.claims.get(event.id) ?? {
      generation: 0,
      expiresAtMs: 0,
    };
    const live = current.ownerId !== undefined && current.expiresAtMs > now;
    if (live) return null;
    current.generation++;
    current.ownerId = ownerId;
    current.expiresAtMs = now + leaseMs;
    this.claims.set(event.id, current);
    return {
      event,
      ownerId,
      generation: current.generation,
      expiresAt: new Date(current.expiresAtMs),
    };
  }

  async renewClaim(
    sessionId: string,
    eventId: string,
    claim: PendingEventClaimRef,
    leaseMs: number,
  ): Promise<boolean> {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new RangeError("pending event leaseMs must be a positive finite number");
    }
    if ((this.queues.get(sessionId) ?? [])[0]?.id !== eventId) return false;
    const current = this.claims.get(eventId);
    const now = Date.now();
    if (
      !current ||
      current.ownerId !== claim.ownerId ||
      current.generation !== claim.generation ||
      current.expiresAtMs <= now
    ) {
      return false;
    }
    current.expiresAtMs = now + leaseMs;
    return true;
  }

  async releaseClaim(
    sessionId: string,
    eventId: string,
    claim: PendingEventClaimRef,
  ): Promise<boolean> {
    if ((this.queues.get(sessionId) ?? [])[0]?.id !== eventId) return false;
    const current = this.claims.get(eventId);
    if (
      !current ||
      current.ownerId !== claim.ownerId ||
      current.generation !== claim.generation
    ) {
      return false;
    }
    current.ownerId = undefined;
    current.expiresAtMs = 0;
    return true;
  }

  async ownsClaim(
    sessionId: string,
    eventId: string,
    claim: PendingEventClaimRef,
  ): Promise<boolean> {
    if ((this.queues.get(sessionId) ?? [])[0]?.id !== eventId) return false;
    const current = this.claims.get(eventId);
    return Boolean(
      current &&
      current.ownerId === claim.ownerId &&
      current.generation === claim.generation &&
      current.expiresAtMs > Date.now(),
    );
  }

  async ack(
    sessionId: string,
    eventId: string,
    claim?: PendingEventClaimRef,
  ): Promise<boolean> {
    const queue = this.queues.get(sessionId) ?? [];
    if (queue[0]?.id !== eventId) return false;
    const current = this.claims.get(eventId);
    if (current?.ownerId) {
      if (
        !claim ||
        current.ownerId !== claim.ownerId ||
        current.generation !== claim.generation ||
        current.expiresAtMs <= Date.now()
      ) {
        return false;
      }
    } else if (claim) {
      return false;
    }
    queue.shift();
    this.claims.delete(eventId);
    return true;
  }

  async listPendingSessionIds(): Promise<string[]> {
    return [...this.queues.entries()]
      .filter(([, queue]) => queue.length > 0)
      .map(([sessionId]) => sessionId)
      .sort();
  }

  async clear(sessionId: string): Promise<void> {
    for (const event of this.queues.get(sessionId) ?? []) {
      this.claims.delete(event.id);
    }
    this.queues.delete(sessionId);
  }

  async count(sessionId: string): Promise<number> {
    const queue = this.queues.get(sessionId) ?? [];
    return queue.length;
  }
}
