import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createPgPool, OSSEnvironmentBuildLogStore, PgEnvironmentStore, pgConfigFromEnv } from "@oma-server/store";
import { E2BSandboxClient } from "@oma-server/sandbox";
import { EnvironmentBuilder } from "./builder.js";
import { loadBuiltInEnvironments, rebuildOnNewBaseImages, syncBuiltInEnvironments } from "./builtin-environments.js";
import { AcsImageCaches } from "./acs-image-cache.js";
import { KubernetesWarmPool, WarmPoolUpdater } from "./warm-pool.js";
import { imageBuilderConfigFromEnv } from "./config.js";
import { inClusterKubernetesApi } from "./kubernetes-api.js";
import { BUILD_POD_DEFAULTS, KubernetesBuildRunner } from "./pod-runner.js";
import { systemClock } from "./ports.js";
import { SandboxImageVerifier } from "./verifier.js";

/** Graceful-stop budget: delete running pods and release their leases before SIGKILL. */
const STOP_MS = 25_000;

/**
 * `oma-image-builder`, the server image's third role (ADR-0024 "Building"):
 * one replica per deployment environment claims Environment Builds from
 * PostgreSQL and runs them in build pods. It serves only `/health` and
 * `/ready`; the API serves build state and logs.
 */
export async function startImageBuilder(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = imageBuilderConfigFromEnv(env);
  const pgConfig = pgConfigFromEnv(env);
  const pool = createPgPool(pgConfig);
  await pool.query("SELECT 1");
  const store = new PgEnvironmentStore(pool);
  const logs = new OSSEnvironmentBuildLogStore(config.oss);
  // Before claiming: the repository's built-ins, then every Environment a
  // new Base Image digest must rebuild (ADR-0024).
  await syncBuiltInEnvironments(store, await loadBuiltInEnvironments(config.builtInEnvironmentsDir));
  await rebuildOnNewBaseImages(store, config.baseImages);
  const kubernetes = await inClusterKubernetesApi(env);
  const warmPool = config.warmPool && new WarmPoolUpdater({
    store, environmentId: config.warmPool.environmentId, clock: systemClock,
    pool: new KubernetesWarmPool(kubernetes, config.warmPool.namespace, config.warmPool.name),
    caches: config.warmPool.imageCache && new AcsImageCaches(config.warmPool.imageCache),
  });
  const runner = new KubernetesBuildRunner(kubernetes, {
    namespace: config.namespace, deployment: config.environment, buildahImage: config.buildahImage,
    registryAuthSecret: config.registryAuthSecret, imagePullSecret: config.imagePullSecret, ...BUILD_POD_DEFAULTS,
  }, systemClock);
  const client = new E2BSandboxClient({
    ...config.sandbox,
    verifyWorkspaceProbe: async () => { throw new Error("Verification Sandboxes mount no Workspace"); },
  });
  const builder = new EnvironmentBuilder({
    queue: store, runner, logs, clock: systemClock,
    verifier: new SandboxImageVerifier({ client, environment: config.environment }),
    config: {
      owner: `${hostname()}-${randomUUID().slice(0, 8)}`,
      deployment: config.environment, repository: config.repository, baseImages: config.baseImages,
      platformDefaults: config.platformDefaults, proxy: config.proxy,
    },
    onBuildEnd: (build, outcome) => {
      if (outcome === "succeeded" && build.environmentId === config.warmPool?.environmentId) warmPool?.trigger();
    },
  });
  await builder.start();
  warmPool?.start();

  const app = new Hono();
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/ready", async (c) => {
    try {
      await pool.query("SELECT 1");
      return c.json({ status: "ok", role: "image-builder", running: builder.runningCount });
    } catch { return c.json({ status: "unavailable" }, 503); }
  });
  const server = serve({ fetch: app.fetch, port: Number(env.PORT ?? 3002) }, (info) => {
    console.log(`image-builder listening on http://localhost:${info.port}`);
  });
  let stopping: Promise<void> | undefined;
  const shutdown = (signal: string) => stopping ??= (async () => {
    console.log(`image-builder stopping on ${signal}`);
    await Promise.race([Promise.all([builder.stop(), warmPool?.stop()]), new Promise((resolve) => setTimeout(resolve, STOP_MS))]);
    server.close();
    await pool.end();
  })();
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
    void shutdown(signal).then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
  });
}
