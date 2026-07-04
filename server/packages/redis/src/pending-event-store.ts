import { nanoid } from "nanoid";
import type {
  PendingEvent,
  PendingEventEnqueueInput,
  PendingEventStore,
} from "@oma-server/store";
import type { RedisLike } from "./redis-like.js";

/**
 * Redis-backed pending-input queue (ADR-0002 §3): the pending queue is
 * transient traffic, so it lives in Redis rather than PostgreSQL.
 *
 * One Redis LIST per session (`pending:session:{sessionId}`). Enqueue is RPUSH
 * (tail), dequeue is LPOP (head) — FIFO. Each entry is a JSON-serialized
 * PendingEvent so `arrivedAt`/`id` survive the round trip.
 */
function queueKey(sessionId: string): string {
  return `pending:session:${sessionId}`;
}

interface SerializedPending {
  id: string;
  sessionId: string;
  type: string;
  data: unknown;
  sessionThreadId: string;
  arrivedAt: string;
}

function deserialize(raw: string): PendingEvent {
  const p = JSON.parse(raw) as SerializedPending;
  return {
    id: p.id,
    sessionId: p.sessionId,
    type: p.type,
    data: p.data,
    sessionThreadId: p.sessionThreadId,
    arrivedAt: new Date(p.arrivedAt),
  };
}

export class RedisPendingEventStore implements PendingEventStore {
  constructor(private readonly redis: RedisLike) {}

  async enqueue(sessionId: string, event: PendingEventEnqueueInput): Promise<PendingEvent> {
    const pending: PendingEvent = {
      id: nanoid(),
      sessionId,
      type: event.type,
      data: event.data,
      sessionThreadId: event.sessionThreadId,
      arrivedAt: new Date(),
    };
    const serialized: SerializedPending = {
      ...pending,
      arrivedAt: pending.arrivedAt.toISOString(),
    };
    await this.redis.rpush(queueKey(sessionId), JSON.stringify(serialized));
    return pending;
  }

  async dequeue(sessionId: string): Promise<PendingEvent | null> {
    const raw = await this.redis.lpop(queueKey(sessionId));
    return raw ? deserialize(raw) : null;
  }

  async peek(sessionId: string): Promise<PendingEvent | null> {
    const raw = await this.redis.lindex(queueKey(sessionId), 0);
    return raw ? deserialize(raw) : null;
  }

  async count(sessionId: string): Promise<number> {
    return this.redis.llen(queueKey(sessionId));
  }
}
