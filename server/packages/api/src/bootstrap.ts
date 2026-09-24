import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createPgPool, pgConfigFromEnv, createPgStores, OSSArtifactStore, S3SkillArtifactStore, OSSEventPayloadStore, EventPayloadCodec, type ArtifactStore, type SkillArtifactStore } from "@oma-server/store";
import { createRedisClient, redisConfigFromEnv, RedisTurnStreamStore, BestEffortTurnStreamStore, RedisSessionSignals } from "@oma-server/redis";
import { RedisEventStreamHub } from "@oma-server/event-log";
import { createApp } from "./app.js";
import { workspaceStorageConfigFromEnv } from "./lib/workspace-config.js";
import { createGracefulShutdown } from "./lib/graceful-shutdown.js";
import { ModelProviderService } from "./lib/model-providers.js";

export type HostRole = "api" | "runner" | "combined";

/** Shared infrastructure; execution dependencies are loaded only by a Runner. */
export async function startHost(role: HostRole): Promise<void> {
  const local = process.env.OMA_LOCAL_INFRA === "true";
  const pgConfig = pgConfigFromEnv();
  if (local) {
    // Local smoke tests must never inherit a production database from the shell.
    const url = new URL(pgConfig.connectionString ?? "invalid:");
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !url.pathname.startsWith("/oma_local")) {
      throw new Error("OMA_LOCAL_INFRA requires a loopback PG_URL and an oma_local database");
    }
    process.env.AUTH_DISABLED ??= "true";
  }
  const pool = createPgPool(pgConfig);
  await pool.query("SELECT 1");
  const oss = local ? undefined : workspaceStorageConfigFromEnv(process.env);
  const stores = await createPgStores(pool, {
    schema: pgConfig.schema, ensureSchema: process.env.PG_ENSURE_SCHEMA !== "false",
    payloads: oss ? new EventPayloadCodec(new OSSEventPayloadStore(oss)) : undefined,
  });
  const redis = createRedisClient(redisConfigFromEnv(), {
    enableOfflineQueue: false, maxRetriesPerRequest: 0, commandTimeout: 250, connectTimeout: 1000,
  });
  redis.on("error", () => {});
  void redis.connect().catch(() => {}); // Startup and readiness do not depend on Redis.
  const signals = new RedisSessionSignals(redis, process.env.REDIS_NAMESPACE ?? `oma:${pgConfig.schema ?? "oma"}`);
  const eventStreamHub = new RedisEventStreamHub(signals);
  const turnStreamStore = new BestEffortTurnStreamStore(new RedisTurnStreamStore(redis), () => redis.status === "ready");
  let artifactStore: ArtifactStore;
  let skillArtifactStore: SkillArtifactStore;
  if (local) {
    // Explicit local mock profile only; PG + Redis and entrypoints are real.
    const { InMemoryArtifactStore, InMemorySkillArtifactStore } = await import("@oma-server/store-memory");
    artifactStore = new InMemoryArtifactStore();
    skillArtifactStore = new InMemorySkillArtifactStore();
  } else {
    artifactStore = new OSSArtifactStore(oss!);
    await artifactStore.list("oma_startup", "storage_check");
    const endpoint = process.env.S3_ENDPOINT || process.env.SUPABASE_STORAGE_URL;
    const serviceKey = process.env.S3_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;
    if (!endpoint || !serviceKey) throw new Error("Skills require S3_ENDPOINT and S3_SERVICE_KEY");
    // Captured direct dispatcher keeps internal Storage off the model proxy.
    const { Agent } = await import("undici");
    const directDispatcher = new Agent();
    const directFetch: typeof fetch = (input, init) => fetch(input, { ...init, dispatcher: directDispatcher } as RequestInit);
    skillArtifactStore = new S3SkillArtifactStore({ endpoint, serviceKey, bucket: process.env.S3_BUCKET || "workspace", fetch: directFetch });
  }
  const deps = { ...stores, artifactStore, skillArtifactStore, eventStreamHub, turnStreamStore };
  const execution = role === "api" ? undefined : await (await import("./execution.js")).startExecution({ ...deps, pool, signals, local });
  const app = new Hono();
  if (role !== "runner") app.route("/", createApp({
    ...deps, fullApiKeyStore: stores.apiKeyStore,
    modelProviderService: new ModelProviderService(stores.modelProviderStore, process.env.OMA_PROVIDER_ENCRYPTION_KEY),
    wakeSession: sessionId => signals.publish({ sessionId, kind: "wake" }),
    sseCatchupIntervalMs: Number(process.env.SSE_CATCHUP_INTERVAL_MS ?? 2000),
  }));
  const healthPath = role === "runner" ? "" : (process.env.API_BASE_PATH ?? "").replace(/\/$/, "");
  if (role === "runner") app.get("/health", c => c.json({ status: "ok" }));
  app.get(`${healthPath}/ready`, async c => {
    try {
      await pool.query("SELECT 1");
      if (execution && !execution.ready()) return c.json({ status: "unavailable" }, 503);
      return c.json({ status: "ok", role });
    } catch { return c.json({ status: "unavailable" }, 503); }
  });
  const server = serve({ fetch: app.fetch, port: Number(process.env.PORT ?? (role === "runner" ? 3001 : 3000)) }, info => {
    console.log(`${role} listening on http://localhost:${info.port}`);
  });
  const shutdown = createGracefulShutdown({
    server, stopBackgroundWork: () => execution?.stop() ?? Promise.resolve(),
    waitForIdle: ms => execution?.router.waitForIdle(ms) ?? Promise.resolve(true),
    timeoutMs: Number(process.env.SHUTDOWN_GRACE_MS ?? 20_000),
    closeResources: async () => { eventStreamHub.close(); signals.close(); redis.disconnect(); await pool.end(); },
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
    void shutdown(signal).then(() => process.exit(0), error => { console.error(error); process.exit(1); });
  });
}
