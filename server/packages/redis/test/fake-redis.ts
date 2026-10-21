import type { RedisLike } from "../src/redis-like.js";

/**
 * Minimal in-memory fake implementing the RedisLike command surface used by
 * the transient stores. Enough to unit-test XADD/XRANGE/XLEN/DEL streams,
 * hashes and key expiry without a live Redis. Expiry reads the injected
 * clock, so tests can move time instead of waiting.
 */
export class FakeRedis implements RedisLike {
  private streams = new Map<string, Array<[string, string[]]>>();
  private hashes = new Map<string, Record<string, string>>();
  private expiries = new Map<string, number>();
  private seq = 0;

  constructor(private readonly now: () => number = Date.now) {}

  async eval(script: string, numberOfKeys: number, ...keysAndArgs: string[]): Promise<unknown> {
    this.evictExpired();
    if (numberOfKeys === 1 && script.includes("oma:active-turn-cas")) {
      const [key, expectedTurnId, expectedGeneration, nextTurnId, nextStatus, nextGeneration] = keysAndArgs;
      const current = this.hashes.get(key);
      if ((current?.turnId ?? "") !== expectedTurnId) return 0;
      if (current && (current.generation ?? "0") !== expectedGeneration) return 0;
      if (!nextTurnId) this.hashes.delete(key);
      else this.hashes.set(key, { turnId: nextTurnId, status: nextStatus, generation: nextGeneration });
      return 1;
    }
    if (numberOfKeys === 1 && script.includes("oma:turn-delta-append")) {
      const [key, ttlMs, ...fieldsAndValues] = keysAndArgs;
      const id = await this.xadd(key, "*", ...fieldsAndValues);
      this.pexpire(key, Number(ttlMs));
      return id;
    }
    throw new Error("FakeRedis received an unsupported Lua script");
  }

  // ─── Streams ───────────────────────────────────────────────────────────────
  /** Not on RedisLike (stores append via a script); serves that script and lets tests plant streams. */
  async xadd(key: string, id: string, ...fieldsAndValues: string[]): Promise<string | null> {
    this.evictExpired();
    const stream = this.streams.get(key) ?? [];
    // Monotonic ids of the shape "<ms>-<seq>"; the exact clock does not matter
    // for tests, only strict ordering and uniqueness.
    const entryId = id === "*" ? `${this.now()}-${this.seq++}` : id;
    stream.push([entryId, fieldsAndValues]);
    this.streams.set(key, stream);
    return entryId;
  }

  async xrange(key: string, start: string, end: string): Promise<Array<[string, string[]]>> {
    this.evictExpired();
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
    this.evictExpired();
    return this.streams.get(key)?.length ?? 0;
  }

  // ─── Hashes ──────────────────────────────────────────────────────────────
  async hset(key: string, ...fieldsAndValues: string[]): Promise<number> {
    this.evictExpired();
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
    this.evictExpired();
    return { ...(this.hashes.get(key) ?? {}) };
  }

  // ─── Keyspace ──────────────────────────────────────────────────────────────
  async del(...keys: string[]): Promise<number> {
    this.evictExpired();
    let removed = 0;
    for (const key of keys) {
      this.expiries.delete(key);
      if (this.streams.delete(key)) removed++;
      if (this.hashes.delete(key)) removed++;
    }
    return removed;
  }

  /** PEXPIRE: only reachable through the scripts the stores send. */
  private pexpire(key: string, ttlMs: number): number {
    if (!this.streams.has(key) && !this.hashes.has(key)) return 0;
    this.expiries.set(key, this.now() + ttlMs);
    return 1;
  }

  /** Redis treats a key as gone once the clock is past its deadline. */
  private evictExpired(): void {
    const now = this.now();
    for (const [key, deadline] of this.expiries) {
      if (now <= deadline) continue;
      this.expiries.delete(key);
      this.streams.delete(key);
      this.hashes.delete(key);
    }
  }

  // ─── Test introspection ──────────────────────────────────────────────────
  hasStream(key: string): boolean {
    this.evictExpired();
    return this.streams.has(key);
  }
}

function compareIds(a: string, b: string): number {
  const [aMs, aSeq] = a.split("-").map(Number);
  const [bMs, bSeq] = b.split("-").map(Number);
  if (aMs !== bMs) return aMs - bMs;
  return (aSeq ?? 0) - (bSeq ?? 0);
}
