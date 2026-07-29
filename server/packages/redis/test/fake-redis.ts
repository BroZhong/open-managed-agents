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

  async eval(script: string, numberOfKeys: number, ...keysAndArgs: string[]): Promise<unknown> {
    if (numberOfKeys !== 1 || !script.includes("oma:active-turn-cas")) {
      throw new Error("FakeRedis received an unsupported Lua script");
    }
    const [key, expected, nextTurnId, nextStatus] = keysAndArgs;
    const current = this.hashes.get(key)?.turnId ?? "";
    if (current !== expected) return 0;
    if (!nextTurnId) this.hashes.delete(key);
    else this.hashes.set(key, { turnId: nextTurnId, status: nextStatus });
    return 1;
  }

  // ─── Cursor scan ──────────────────────────────────────────────────────────
  async scan(
    _cursor: string | number,
    _patternToken: "MATCH",
    pattern: string,
    _countToken: "COUNT",
    _count: string | number,
  ): Promise<[string, string[]]> {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    const matcher = new RegExp(`^${escaped}$`);
    const keys = new Set([
      ...this.streams.keys(),
      ...this.hashes.keys(),
      ...this.lists.keys(),
    ]);
    return ["0", [...keys].filter((key) => matcher.test(key)).sort()];
  }

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

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) ?? [];
    const from = start < 0 ? Math.max(list.length + start, 0) : start;
    // Redis LRANGE stop is inclusive and clamps rather than erroring.
    const to = stop < 0 ? list.length + stop : stop;
    return list.slice(from, to + 1);
  }

  async lrem(key: string, count: number, value: string): Promise<number> {
    const list = this.lists.get(key) ?? [];
    const max = count === 0 ? Number.POSITIVE_INFINITY : Math.abs(count);
    let removed = 0;
    if (count >= 0) {
      for (let i = 0; i < list.length && removed < max;) {
        if (list[i] === value) {
          list.splice(i, 1);
          removed++;
        } else {
          i++;
        }
      }
    } else {
      for (let i = list.length - 1; i >= 0 && removed < max; i--) {
        if (list[i] === value) {
          list.splice(i, 1);
          removed++;
        }
      }
    }
    return removed;
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
