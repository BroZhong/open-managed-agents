// Real repository Host + SessionRouter, isolated in-memory persistence and Adapter.
// Never shipped in the npm package; no production configuration is loaded.
import { serve } from "../../server/packages/api/node_modules/@hono/node-server/dist/index.mjs";
import { createApp } from "../../server/packages/api/src/app.js";
import { createMemoryStores } from "../../server/packages/store-memory/src/index.js";
import { InProcessEventStreamHub } from "../../server/packages/event-log/src/index.js";
import { SessionRouter } from "../../server/packages/session-router/src/index.js";
import { EnvironmentService } from "../../server/packages/api/src/lib/environments.js";
process.env.AUTH_DISABLED = "true";
process.env.API_BASE_PATH = "";
const stores = createMemoryStores();
const hub = new InProcessEventStreamHub();
const agent = await stores.agentStore.create({
  tenantId: "dev",
  name: "CLI integration",
  runtime: "mock",
  model: "test",
  system: "test",
  sandbox: { enabled: false },
});
const router = new SessionRouter({
  ...stores,
  eventStreamHub: hub,
  resolveAdapter: () => ({
    async run(input) {
      const text = input.message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      await new Promise((r) => setTimeout(r, 100));
      input.journal.record({
        id: "reply-" + text,
        timestamp: new Date().toISOString(),
        type: "agent.message",
        content: [
          { type: "text", text: "reply " + text },
          { type: "text", text: "second block" },
        ],
      });
      await input.journal.flush();
      return "finished";
    },
  }),
});
// Inject accepted input in the exact #179 completion-before-acknowledgement seam.
const append = stores.eventLogStore.append.bind(stores.eventLogStore);
let injected = false;
stores.eventLogStore.append = async (sessionId, event) => {
  const stored = await append(sessionId, event);
  if (event.type === "session.turn_completed" && !injected) {
    injected = true;
    await stores.pendingEventStore.enqueue(sessionId, {
      type: "user.message",
      data: { content: [{ type: "text", text: "B" }] },
      sessionThreadId: "sthr_primary",
    });
  }
  return stored;
};
await stores.environmentStore.create({
  id: "env_video_production",
  owner: { ownerType: "platform" },
  name: "video-production",
  description: "Built-in",
  baseImage: "oma-media",
  initScript: "true\n",
  env: [{ name: "GEMINI_API_KEY", secretRef: { source: "platform", key: "GEMINI_API_KEY" } }],
  encryptedSecrets: {},
});
// A built Environment of the Tenant, which Agents and Sessions can use.
await stores.environmentStore.create({
  id: "env_cli_tools",
  owner: { ownerType: "tenant", tenantId: "dev" },
  name: "cli-tools",
  description: "",
  baseImage: "oma-base",
  initScript: "true\n",
  env: [],
  encryptedSecrets: {},
});
stores.environmentStore.succeedBuild("env_cli_tools", "registry.example/welltop/oma-environments@sha256:" + "d".repeat(64));
const app = createApp({
  ...stores,
  eventStreamHub: hub,
  sessionRouter: router,
  environmentService: new EnvironmentService(stores.environmentStore, "ab".repeat(32), {
    inUse: (tenantId, id) => stores.agentStore.usesEnvironment(tenantId, id),
  }),
});
const server = serve(
  { fetch: app.fetch, port: 0, hostname: "127.0.0.1" },
  (info) =>
    process.stdout.write(
      JSON.stringify({
        url: `http://127.0.0.1:${info.port}`,
        agentId: agent.id,
      }) + "\n",
    ),
);
process.on("SIGTERM", () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
