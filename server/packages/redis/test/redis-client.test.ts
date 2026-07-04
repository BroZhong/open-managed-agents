import { describe, it, expect, afterEach } from "vitest";
import { createRedisClient, redisConfigFromEnv, type RedisClient } from "../src/index.js";

describe("redisConfigFromEnv", () => {
  it("prefers REDIS_URL when set", () => {
    const cfg = redisConfigFromEnv({ REDIS_URL: "redis://:pw@host:6380/2" } as NodeJS.ProcessEnv);
    expect(cfg.url).toBe("redis://:pw@host:6380/2");
  });

  it("reads discrete host/port/password/db fields", () => {
    const cfg = redisConfigFromEnv({
      REDIS_HOST: "10.0.56.147",
      REDIS_PORT: "6379",
      REDIS_PASSWORD: "secret",
      REDIS_DB: "3",
    } as NodeJS.ProcessEnv);
    expect(cfg).toEqual({
      url: undefined,
      host: "10.0.56.147",
      port: 6379,
      password: "secret",
      db: 3,
    });
  });

  it("returns undefined fields when env is empty", () => {
    const cfg = redisConfigFromEnv({} as NodeJS.ProcessEnv);
    expect(cfg.url).toBeUndefined();
    expect(cfg.host).toBeUndefined();
    expect(cfg.port).toBeUndefined();
  });
});

describe("createRedisClient", () => {
  let client: RedisClient | undefined;

  afterEach(() => {
    client?.disconnect();
    client = undefined;
  });

  it("builds a lazy client from discrete config without connecting", () => {
    client = createRedisClient({ host: "127.0.0.1", port: 6379, password: "pw" });
    // lazyConnect => status is "wait" until an explicit connect/command.
    expect(client.status).toBe("wait");
    expect(client.options.host).toBe("127.0.0.1");
    expect(client.options.port).toBe(6379);
    expect(client.options.password).toBe("pw");
  });

  it("builds a lazy client from a URL without connecting", () => {
    client = createRedisClient({ url: "redis://:pw@example.com:6380/1" });
    expect(client.status).toBe("wait");
    expect(client.options.host).toBe("example.com");
    expect(client.options.port).toBe(6380);
  });

  it("defaults host/port when none supplied", () => {
    client = createRedisClient();
    expect(client.options.host).toBe("127.0.0.1");
    expect(client.options.port).toBe(6379);
  });
});
