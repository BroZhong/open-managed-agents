import { Redis, type RedisOptions } from "ioredis";

export type RedisClient = Redis;

export type { RedisLike } from "./redis-like.js";

export {
  RedisTurnStreamStore,
} from "./turn-stream-store.js";
export { InMemoryTurnStreamStore } from "./in-memory-turn-stream-store.js";
export type {
  TurnStreamStore,
  TurnDelta,
  StoredTurnDelta,
  ActiveTurn,
  ActiveTurnStatus,
} from "./turn-stream-store.js";

export { RedisPendingEventStore } from "./pending-event-store.js";

export interface RedisConnectionConfig {
  /** Full connection URL (redis://[:password@]host:port[/db]). Takes precedence. */
  url?: string;
  host?: string;
  port?: number;
  password?: string;
  db?: number;
}

/**
 * Read a RedisConnectionConfig from the environment.
 *
 * Precedence: REDIS_URL (connection string), otherwise the discrete
 * REDIS_HOST / REDIS_PORT / REDIS_PASSWORD / REDIS_DB fields.
 */
export function redisConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RedisConnectionConfig {
  return {
    url: env.REDIS_URL,
    host: env.REDIS_HOST,
    port: env.REDIS_PORT ? Number(env.REDIS_PORT) : undefined,
    password: env.REDIS_PASSWORD,
    db: env.REDIS_DB ? Number(env.REDIS_DB) : undefined,
  };
}

/**
 * Create an ioredis client from config. When `url` is set it is used directly;
 * otherwise discrete host/port/password/db fields are used. `lazyConnect` keeps
 * the client from dialing until first use, so wiring it in is side-effect-free.
 */
export function createRedisClient(
  config: RedisConnectionConfig = {},
  options: RedisOptions = {},
): RedisClient {
  const base: RedisOptions = {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    ...options,
  };

  if (config.url) {
    return new Redis(config.url, base);
  }

  return new Redis({
    host: config.host ?? "127.0.0.1",
    port: config.port ?? 6379,
    password: config.password,
    db: config.db,
    ...base,
  });
}
