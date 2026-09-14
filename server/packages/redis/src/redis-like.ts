/**
 * Narrow structural interface over the subset of Redis commands used by the
 * transient stores in this package (delta streams, active-turn map, pending
 * queue).
 *
 * The real ioredis `Redis` client satisfies this shape, and an in-memory fake
 * can implement it for unit tests — keeping the stores decoupled from a live
 * Redis while exercising the exact command surface they depend on.
 */
export interface RedisLike {
  // ─── Atomic scripts ───────────────────────────────────────────────────────
  eval(script: string, numberOfKeys: number, ...keysAndArgs: string[]): Promise<unknown>;

  // ─── Cursor scan (startup pending-input recovery) ───────────────────────────
  scan(
    cursor: string | number,
    patternToken: "MATCH",
    pattern: string,
    countToken: "COUNT",
    count: string | number,
  ): Promise<[string, string[]]>;

  // ─── Streams (per-turn deltas) ─────────────────────────────────────────────
  xadd(key: string, id: string, ...fieldsAndValues: string[]): Promise<string | null>;
  xrange(key: string, start: string, end: string): Promise<Array<[string, string[]]>>;
  xlen(key: string): Promise<number>;

  // ─── Hashes (active-turn map) ──────────────────────────────────────────────
  hset(key: string, ...fieldsAndValues: string[]): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;

  // ─── Lists (pending-input queue) ───────────────────────────────────────────
  rpush(key: string, ...values: string[]): Promise<number>;
  lpop(key: string): Promise<string | null>;
  lindex(key: string, index: number): Promise<string | null>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  lrem(key: string, count: number, value: string): Promise<number>;
  llen(key: string): Promise<number>;

  // ─── Keyspace ──────────────────────────────────────────────────────────────
  del(...keys: string[]): Promise<number>;
}
