import { randomBytes } from "node:crypto";
import { ModelProviderService } from "./lib/model-providers.js";
import { EnvironmentService } from "./lib/environments.js";
import { PiAgentAdapter } from "@open-managed-agents/adapter-pi-agent";
import { serve } from "@hono/node-server";
import { createMemoryStores, InMemoryEnvironmentBuildLogStore } from "@oma-server/store-memory";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { SessionRouter } from "@oma-server/session-router";
import { createApp } from "./app.js";
import type { Adapter } from "@open-managed-agents/adapter-core";
import { MockAdapter } from "@open-managed-agents/adapter-mock";
import { createGracefulShutdown } from "./lib/graceful-shutdown.js";
import { LoopScheduler } from "./lib/loop-scheduler.js";
import { runtimeAdapters } from "./lib/runtime-adapters.js";
import { memoryPiAgentAdapter } from "./lib/memory-pi-agent.js";

const PORT = parseInt(process.env.PORT || "3000", 10);

process.env.AUTH_DISABLED = process.env.AUTH_DISABLED || "true";

// ─── Mock Adapter (echo) ────────────────────────────────────────────────────

const mockAdapter = new MockAdapter({ delayMs: 75 });

// ─── Main ───────────────────────────────────────────────────────────────────

let configuredPiAgentAdapter: Adapter = memoryPiAgentAdapter;

async function main() {
  const stores = createMemoryStores();
  const secretKey = randomBytes(32).toString("hex");
  const modelProviderService = new ModelProviderService(stores.modelProviderStore, secretKey);
  configuredPiAgentAdapter = new PiAgentAdapter({ configureModelRuntime: modelProviderService.configureRuntime(stores.sessionStore) });
  const eventStreamHub = new InProcessEventStreamHub();

  // Create a dev seed key so auth can be tested
  await stores.apiKeyStore.create("dev", "dev-console");

  // In-memory development has no real OSS mount. Use the full server with
  // Workspace OSS configuration to exercise sandbox-backed execution.

  const sessionRouter = new SessionRouter({
    delegationStore: stores.delegationStore,
    eventLogStore: stores.eventLogStore,
    pendingEventStore: stores.pendingEventStore,
    sessionStore: stores.sessionStore,
    eventStreamHub,
    resolveAdapter: runtimeAdapters({ "pi-agent": configuredPiAgentAdapter, mock: mockAdapter }),
    agentStore: stores.agentStore,
    agentFileStore: stores.agentFileStore,
    skillStore: stores.skillStore,
  });

  // Keep startup semantics identical to the full server. The in-memory queues
  // are normally empty on process start, but tests/dev embedding can seed them
  // before wiring the app and still exercise the same recovery entry point.
  const pendingRecovery = await sessionRouter.recoverPendingEvents(({ sessionId, error }) => {
    console.error(`Background pending recovery failed for ${sessionId}:`, error);
  });
  console.log(
    `Pending recovery: ${pendingRecovery.recovered.length} recovered, ` +
    `${pendingRecovery.discarded.length} discarded, ${pendingRecovery.failed.length} failed`,
  );
  for (const failure of pendingRecovery.failed) {
    console.error(`Pending recovery failed for ${failure.sessionId}:`, failure.error);
  }

  const loopScheduler = new LoopScheduler({
    loopStore: stores.loopStore,
    sessionRouter,
    pollIntervalMs: Number(process.env.LOOP_POLL_INTERVAL_MS ?? 15_000),
  });
  loopScheduler.start();

  const app = createApp({
    modelProviderService,
    environmentService: new EnvironmentService(stores.environmentStore, secretKey, {
      inUse: (tenantId, id) => stores.agentStore.usesEnvironment(tenantId, id),
      logs: new InMemoryEnvironmentBuildLogStore(),
    }),
    thinkingOptions: (tenant, model) => modelProviderService.thinkingOptions(tenant, model, async raw => (await import("@open-managed-agents/adapter-pi-agent")).managedThinkingOptions(raw)),
    sessionShareStore: stores.sessionShareStore,
    delegationStore: stores.delegationStore,
    apiKeyStore: stores.apiKeyStore,
    fullApiKeyStore: stores.apiKeyStore,
    agentStore: stores.agentStore,
    agentFileStore: stores.agentFileStore,
    skillStore: stores.skillStore,
    skillBundleStore: stores.skillBundleStore,
    sessionStore: stores.sessionStore,
    eventLogStore: stores.eventLogStore,
    pendingEventStore: stores.pendingEventStore,
    workspaceStore: stores.workspaceStore,
    loopStore: stores.loopStore,
    userStore: stores.userStore,
    eventStreamHub,
    sessionRouter,
  });

  const httpServer = serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`\nServer listening on http://localhost:${info.port}`);
    console.log(`Storage: in-memory (no PostgreSQL/Redis required)`);
    console.log(`AUTH_DISABLED=${process.env.AUTH_DISABLED}`);
    console.log(`Runtimes: pi-agent, mock`);
    console.log(`\nDev API key seeded (value hidden)`);
    console.log(`\nTry: curl http://localhost:${info.port}/health`);
  });

  const shutdown = createGracefulShutdown({
    server: httpServer,
    stopBackgroundWork: () => loopScheduler.stop(),
    handOff: (timeoutMs) => sessionRouter.handOff(timeoutMs),
    timeoutMs: Number(process.env.SHUTDOWN_GRACE_MS ?? 20_000),
    closeResources: async () => {},
  });
  const handleSignal = (signal: NodeJS.Signals) => {
    void shutdown(signal).then(
      () => process.exit(0),
      (error) => {
        console.error("Graceful shutdown failed:", error);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", handleSignal);
  process.on("SIGINT", handleSignal);
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
