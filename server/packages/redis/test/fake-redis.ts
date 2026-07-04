import type { RedisLike } from "../src/redis-like.js";

/**
 * Minimal in-memory fake implementing the RedisLike command surface used by
 * the transient stores. Enough to unit-test XADD/XRANGE/XLEN/DEL streams,
 * hashes, and list queues without a live Redis.
 */
export class FakeRedis implements RedisLike {
  private streams = new Map<string, Array<[string, string[]]>>();
  private hashes = new Map<string, Record<string, string>>();
  private lists = new Map<string, string[]>();
  private seq = 0;

  // ─── Streams ───────────────────────────────────────────────────────────────
  async xadd(key: string, id: string, ...fieldsAndValues: string[]): Promise<string | null> {
    const stream = this.streams.get(key) ?? [];
    // Monotonic ids of the shape "<ms>-<seq>"; the exact clock does not matter
    // for tests, only strict ordering and uniqueness.
    const entryId = id === "*" ? `${Date.now()}-${this.seq++}` : id;
    stream.push([entryId, fieldsAndValues]);
    this.streams.set(key, stream);
    return entryId;
  }

  async xrange(key: string, start: string, end: string): Promise<Array<[string, string[]]>> {
    const stream = this.streams.get(key) ?? [];
    const exclusive = start.startsWith("(");
    const startId = exclusive ? start.slice(1) : start === "-" ? undefined : start;
    return stream.filter(([id]) => {
      if (startId !== undefined) {
        if (exclusive ? compareIds(id, startId) <= 0 : compareIds(id, startId) < 0) {
          return false;
        }
      }
      if (end !== "+" && compareIds(id, end) > 0) return false;
      return true;
    });
  }

  async xlen(key: string): Promise<number> {
    return this.streams.get(key)?.length ?? 0;
  }

  // ─── Hashes ──────────────────────────────────────────────────────────────
  async hset(key: string, ...fieldsAndValues: string[]): Promise<number> {
    const hash = this.hashes.get(key) ?? {};
    let added = 0;
    for (let i = 0; i + 1 < fieldsAndValues.length; i += 2) {
      if (!(fieldsAndValues[i] in hash)) added++;
      hash[fieldsAndValues[i]] = fieldsAndValues[i + 1];
    }
    this.hashes.set(key, hash);
    return added;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return { ...(this.hashes.get(key) ?? {}) };
  }

  // ─── Lists ───────────────────────────────────────────────────────────────
  async rpush(key: string, ...values: string[]): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.push(...values);
    this.lists.set(key, list);
    return list.length;
  }

  async lpop(key: string): Promise<string | null> {
    const list = this.lists.get(key) ?? [];
    return list.shift() ?? null;
  }

  async lindex(key: string, index: number): Promise<string | null> {
    const list = this.lists.get(key) ?? [];
    const i = index < 0 ? list.length + index : index;
    return list[i] ?? null;
  }

  async llen(key: string): Promise<number> {
    return this.lists.get(key)?.length ?? 0;
  }

  // ─── Keyspace ──────────────────────────────────────────────────────────────
  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.streams.delete(key)) removed++;
      if (this.hashes.delete(key)) removed++;
      if (this.lists.delete(key)) removed++;
    }
    return removed;
  }

  // ─── Test introspection ──────────────────────────────────────────────────
  hasStream(key: string): boolean {
    return this.streams.has(key);
  }
}

function compareIds(a: string, b: string): number {
  const [aMs, aSeq] = a.split("-").map(Number);
  const [bMs, bSeq] = b.split("-").map(Number);
  if (aMs !== bMs) return aMs - bMs;
  return (aSeq ?? 0) - (bSeq ?? 0);
}
