import { nanoid } from "nanoid";
import type {
  PendingEvent,
  PendingEventClaim,
  PendingEventClaimRef,
  PendingEventEnqueueInput,
  PendingEventStore,
} from "@oma-server/store";
import type { RedisLike } from "./redis-like.js";

/**
 * Legacy Redis-backed pending-input queue retained for compatibility/tests.
 * Production uses PostgreSQL as the authoritative pending store so claim +
 * generation fencing is atomic across Hosts. This implementation mirrors the
 * API semantics but must not be selected for multi-Host execution.
 *
 * One Redis LIST per session (`pending:session:{sessionId}`). Enqueue is RPUSH
 * (tail), dequeue is LPOP (head) — FIFO. Each entry is a JSON-serialized
 * PendingEvent so `arrivedAt`/`id` survive the round trip.
 */
function queueKey(sessionId: string): string {
  return `pending:session:${sessionId}`;
}

function claimKey(sessionId: string): string {
  return `pending:claim:${sessionId}`;
}

const QUEUE_PREFIX = "pending:session:";

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
    const current = await this.redis.hgetall(claimKey(sessionId));
    if (current.ownerId) return null;
    const raw = await this.redis.lpop(queueKey(sessionId));
    return raw ? deserialize(raw) : null;
  }

  async peek(sessionId: string): Promise<PendingEvent | null> {
    const raw = await this.redis.lindex(queueKey(sessionId), 0);
    return raw ? deserialize(raw) : null;
  }

  async claim(sessionId: string, ownerId: string, leaseMs: number): Promise<PendingEventClaim | null> {
    if (!ownerId) throw new RangeError("pending event ownerId must not be empty");
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new RangeError("pending event leaseMs must be a positive finite number");
    }
    const event = await this.peek(sessionId);
    if (!event) return null;
    const key = claimKey(sessionId);
    const raw = await this.redis.hgetall(key);
    const now = Date.now();
    const sameHead = raw.eventId === event.id;
    const currentOwner = sameHead ? raw.ownerId : undefined;
    const currentExpiry = sameHead ? Number(raw.expiresAtMs ?? 0) : 0;
    const live = Boolean(currentOwner) && currentExpiry > now;
    if (live) return null;
    const currentGeneration = sameHead ? Number(raw.generation ?? 0) : 0;
    const generation = currentGeneration + 1;
    const expiresAtMs = now + leaseMs;
    await this.redis.hset(
      key,
      "eventId", event.id,
      "ownerId", ownerId,
      "generation", String(generation),
      "expiresAtMs", String(expiresAtMs),
    );
    return {
      event,
      ownerId,
      generation,
      expiresAt: new Date(expiresAtMs),
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
    const key = claimKey(sessionId);
    const raw = await this.redis.hgetall(key);
    if (
      raw.eventId !== eventId ||
      raw.ownerId !== claim.ownerId ||
      Number(raw.generation) !== claim.generation ||
      Number(raw.expiresAtMs) <= Date.now()
    ) {
      return false;
    }
    await this.redis.hset(key, "expiresAtMs", String(Date.now() + leaseMs));
    return true;
  }

  async releaseClaim(
    sessionId: string,
    eventId: string,
    claim: PendingEventClaimRef,
  ): Promise<boolean> {
    const key = claimKey(sessionId);
    const raw = await this.redis.hgetall(key);
    if (
      raw.eventId !== eventId ||
      raw.ownerId !== claim.ownerId ||
      Number(raw.generation) !== claim.generation
    ) {
      return false;
    }
    await this.redis.hset(key, "ownerId", "", "expiresAtMs", "0");
    return true;
  }

  async ownsClaim(
    sessionId: string,
    eventId: string,
    claim: PendingEventClaimRef,
  ): Promise<boolean> {
    const raw = await this.redis.hgetall(claimKey(sessionId));
    return (
      raw.eventId === eventId &&
      raw.ownerId === claim.ownerId &&
      Number(raw.generation) === claim.generation &&
      Number(raw.expiresAtMs) > Date.now()
    );
  }

  async ack(
    sessionId: string,
    eventId: string,
    claim?: PendingEventClaimRef,
  ): Promise<boolean> {
    const key = queueKey(sessionId);
    const raw = await this.redis.lindex(key, 0);
    if (!raw || deserialize(raw).id !== eventId) return false;
    const current = await this.redis.hgetall(claimKey(sessionId));
    if (current.ownerId) {
      if (
        !claim ||
        current.eventId !== eventId ||
        current.ownerId !== claim.ownerId ||
        Number(current.generation) !== claim.generation ||
        Number(current.expiresAtMs) <= Date.now()
      ) {
        return false;
      }
    } else if (claim) {
      return false;
    }
    // LREM matches the exact serialized value (pending ids are unique). If a
    // concurrent acknowledgement won after LINDEX, this returns 0 and cannot
    // accidentally remove the new head.
    const removed = (await this.redis.lrem(key, 1, raw)) > 0;
    if (removed) await this.redis.del(claimKey(sessionId));
    return removed;
  }

  async listPendingSessionIds(): Promise<string[]> {
    const ids = new Set<string>();
    let cursor = "0";
    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        "MATCH",
        `${QUEUE_PREFIX}*`,
        "COUNT",
        "100",
      );
      cursor = nextCursor;
      for (const key of keys) {
        // Empty LIST keys disappear in real Redis; the LLEN guard also keeps
        // lightweight fakes and interrupted cleanup from reporting stale work.
        if (await this.redis.llen(key) > 0) ids.add(key.slice(QUEUE_PREFIX.length));
      }
    } while (cursor !== "0");
    return [...ids].sort();
  }

  async clear(sessionId: string): Promise<void> {
    await this.redis.del(queueKey(sessionId), claimKey(sessionId));
  }

  async count(sessionId: string): Promise<number> {
    return this.redis.llen(queueKey(sessionId));
  }

  async listUnclaimed(sessionId: string, limit: number): Promise<PendingEvent[]> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError("pending event listUnclaimed limit must be a positive integer");
    }
    // This store keeps a single claim record per Session, always describing the
    // FIFO head. Read one extra entry so dropping a live-claimed head still
    // returns a full page of the input behind it.
    const raw = await this.redis.lrange(queueKey(sessionId), 0, limit);
    const events = raw.map(deserialize);
    const claim = await this.redis.hgetall(claimKey(sessionId));
    const claimed =
      Boolean(claim.ownerId) && Number(claim.expiresAtMs) > Date.now()
        ? claim.eventId
        : undefined;
    return events.filter((event) => event.id !== claimed).slice(0, limit);
  }
}
