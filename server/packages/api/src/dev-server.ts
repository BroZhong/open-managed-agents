import { serve } from "@hono/node-server";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createPgPool, pgConfigFromEnv, createPgStores, OSSArtifactStore, S3SkillArtifactStore, OSSEventPayloadStore, EventPayloadCodec } from "@oma-server/store";
import type { SkillArtifactStore } from "@oma-server/store";
import {
  createRedisClient,
  redisConfigFromEnv,
  RedisTurnStreamStore,
} from "@oma-server/redis";
import type { TurnStreamStore } from "@oma-server/redis";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { SessionRouter } from "@oma-server/session-router";
import {
  E2BSandboxClient,
  DefaultSandboxManager,
  S3ProvisionSource,
} from "@oma-server/sandbox";
import { workspaceConfigFromEnv } from "./lib/workspace-config.js";
import { createApp } from "./app.js";
import { adapterProcessEnvFromHost, sandboxEnvPolicyFromHost } from "./lib/sandbox-env.js";
import { sandboxBaseEnvFromKubernetes } from "./lib/sandbox-base-secret.js";
import type {
  Adapter,
  AdapterInput,
  SessionEvent,
} from "@open-managed-agents/adapter-core";
import {
  generateEventId,
  generateTimestamp,
} from "@open-managed-agents/adapter-core";
import { MockAdapter } from "@open-managed-agents/adapter-mock";
import { PiAgentAdapter } from "@open-managed-agents/adapter-pi-agent";
import { Agent as UndiciAgent, ProxyAgent, setGlobalDispatcher } from "undici";
import { createGracefulShutdown } from "./lib/graceful-shutdown.js";
import { LoopScheduler } from "./lib/loop-scheduler.js";
import { translateDevCodexTerminalEvent } from "./lib/dev-codex-events.js";

// Route ALL of Node's global fetch (including the Pi SDK's LLM calls) through an
// egress proxy when configured. The in-cluster sing-box proxy provides the
// configured outbound route for external LLM providers. Node's fetch
// (undici) ignores HTTP(S)_PROXY env, so we must install a global dispatcher.
const proxyUrl = process.env.OMA_PROXY_URL || process.env.HTTPS_PROXY || process.env.https_proxy;
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  console.log(`Global fetch proxy enabled → ${proxyUrl}`);
}

// S3 (Supabase Storage) lives on the internal VPC and must NOT traverse the
// egress proxy — the proxy is for external LLM calls only and closes internal
// connections. Give the S3 stores a direct-dispatcher fetch that bypasses the
// global proxy dispatcher. When no proxy is set this is just plain fetch.
const directDispatcher = new UndiciAgent();
const directFetch: typeof fetch = proxyUrl
  ? ((input, init) =>
      fetch(input, { ...(init ?? {}), dispatcher: directDispatcher } as RequestInit)) as typeof fetch
  : fetch;

const PORT = parseInt(process.env.PORT || "3000", 10);

process.env.AUTH_DISABLED = process.env.AUTH_DISABLED || "true";
const adapterProcessEnv = adapterProcessEnvFromHost(process.env);

// ─── Claude Code Adapter (spawns `claude` CLI) ──────────────────────────────

class DevClaudeCodeAdapter implements Adapter {
  async *run(input: AdapterInput): AsyncIterable<SessionEvent> {
    const prompt = input.message.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    const args = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", "bypassPermissions",
      "-p", prompt,
    ];

    if (input.agent.model) {
      args.push("--model", input.agent.model);
    }
    if (input.agent.system) {
      args.push("--system-prompt", input.agent.system);
    }

    yield { id: generateEventId(), timestamp: generateTimestamp(), type: "session.status_running" } as SessionEvent;

    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: adapterProcessEnv,
    });
    // Catch immediate spawn failures (e.g. ENOENT) synchronously so an
    // unhandled 'error' event can never crash the Host process.
    let spawnError: Error | undefined;
    child.on("error", (err) => {
      spawnError = err instanceof Error ? err : new Error(String(err));
    });
    child.stdin.end();

    const rl = createInterface({ input: child.stdout });
    let hasError = false;

    try {
      if (spawnError) throw spawnError;
      for await (const line of rl) {
        if (!line.trim()) continue;
        let event: any;
        try { event = JSON.parse(line); } catch { continue; }

        if (event.type === "assistant" && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === "text" && block.text) {
              yield {
                id: generateEventId(), timestamp: generateTimestamp(),
                type: "agent.message", content: [{ type: "text", text: block.text }],
              } as SessionEvent;
            } else if (block.type === "thinking" && block.thinking) {
              yield {
                id: generateEventId(), timestamp: generateTimestamp(),
                type: "agent.thinking", text: block.thinking,
              } as SessionEvent;
            }
          }
          if (event.message.usage) {
            yield {
              id: generateEventId(), timestamp: generateTimestamp(),
              type: "span.model_request_end",
              usage: {
                inputTokens:
                  event.message.usage.input_tokens +
                  (event.message.usage.cache_read_input_tokens ?? 0) +
                  (event.message.usage.cache_creation_input_tokens ?? 0),
                outputTokens: event.message.usage.output_tokens,
                cacheReadTokens: event.message.usage.cache_read_input_tokens ?? 0,
                cacheWriteTokens: event.message.usage.cache_creation_input_tokens ?? 0,
              },
            } as SessionEvent;
          }
        }

        if (event.type === "result") {
          if (event.subtype === "error" || event.is_error) {
            hasError = true;
            yield {
              id: generateEventId(), timestamp: generateTimestamp(),
              type: "session.error", error: { message: event.result || "Unknown error", code: "sdk_error" },
            } as SessionEvent;
          }
        }
      }

      await new Promise<void>((resolve, reject) => {
        child.on("close", (code) => {
          if (code !== 0 && !hasError) reject(new Error(`claude exited with code ${code}`));
          else resolve();
        });
        child.on("error", reject);
      });

      if (!hasError) {
        yield { id: generateEventId(), timestamp: generateTimestamp(), type: "session.status_idle" } as SessionEvent;
      }
    } catch (err: unknown) {
      yield {
        id: generateEventId(), timestamp: generateTimestamp(),
        type: "session.error", error: { message: String(err), code: "sdk_error" },
      } as SessionEvent;
    }
  }
}

// ─── Codex Adapter (spawns `codex` CLI) ─────────────────────────────────────

class DevCodexAdapter implements Adapter {
  async *run(input: AdapterInput): AsyncIterable<SessionEvent> {
    const prompt = input.message.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    const args = ["exec", "--json", "-s", "danger-full-access", "--", prompt];

    yield { id: generateEventId(), timestamp: generateTimestamp(), type: "session.status_running" } as SessionEvent;

    const child = spawn("codex", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: adapterProcessEnv,
    });
    // Catch immediate spawn failures (e.g. ENOENT) synchronously so an
    // unhandled 'error' event can never crash the Host process.
    let spawnError: Error | undefined;
    child.on("error", (err) => {
      spawnError = err instanceof Error ? err : new Error(String(err));
    });
    child.stdin.end();

    const rl = createInterface({ input: child.stdout });
    let hasError = false;

    try {
      if (spawnError) throw spawnError;
      for await (const line of rl) {
        if (!line.trim()) continue;
        let event: any;
        try { event = JSON.parse(line); } catch { continue; }

        if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item?.text) {
          yield {
            id: generateEventId(), timestamp: generateTimestamp(),
            type: "agent.message", content: [{ type: "text", text: event.item.text }],
          } as SessionEvent;
        }

        if (event.type === "item.completed" && event.item?.type === "tool_call") {
          yield {
            id: generateEventId(), timestamp: generateTimestamp(),
            type: "agent.tool_use", toolUseId: event.item.id || "", name: event.item.name || "unknown", input: event.item.arguments || {},
          } as SessionEvent;
        }

        if (event.type === "item.completed" && event.item?.type === "tool_call_output") {
          yield {
            id: generateEventId(), timestamp: generateTimestamp(),
            type: "agent.tool_result", toolUseId: event.item.tool_call_id || "", content: [{ type: "text", text: event.item.output || "" }], isError: false,
          } as SessionEvent;
        }

        for (const terminalEvent of translateDevCodexTerminalEvent(event)) {
          if (terminalEvent.type === "session.error") hasError = true;
          yield {
            id: generateEventId(),
            timestamp: generateTimestamp(),
            ...terminalEvent,
          } as SessionEvent;
        }
      }

      await new Promise<void>((resolve, reject) => {
        child.on("close", (code) => {
          if (code !== 0 && !hasError) reject(new Error(`codex exited with code ${code}`));
          else resolve();
        });
        child.on("error", reject);
      });

      if (!hasError) {
        yield { id: generateEventId(), timestamp: generateTimestamp(), type: "session.status_idle" } as SessionEvent;
      }
    } catch (err: unknown) {
      yield {
        id: generateEventId(), timestamp: generateTimestamp(),
        type: "session.error", error: { message: String(err), code: "codex_error" },
      } as SessionEvent;
    }
  }
}

// ─── Pi Agent: the real SDK adapter is used (see resolveAdapter below). ──
// The former inline CLI-spawning DevPiAgentAdapter was removed in favor of
// @open-managed-agents/adapter-pi-agent (SDK + host-tool injection).

// ─── Mock Adapter (echo) ────────────────────────────────────────────────────

// The packaged mock emits model spans and three text chunks, while lifecycle
// events remain solely owned by SessionRouter (the former inline echo doubled
// running/idle and could not exercise Redis/SSE delta delivery).
const mockAdapter = new MockAdapter({ delayMs: 75 });

// ─── Main ───────────────────────────────────────────────────────────────────

// The Pi adapter is the real SDK-based one (@open-managed-agents/adapter-pi-agent):
// it reads the per-run ToolExecutor from AdapterInput.toolExecutor (injected by
// the SessionRouter) and, when present, registers custom tools that proxy into
// it (ADR-0002 §2). A single instance is fine — all per-turn state is per-call.
const piAgentAdapter = new PiAgentAdapter();

function resolveAdapter(runtime: string): Adapter {
  switch (runtime) {
    case "claude-code": return new DevClaudeCodeAdapter();
    case "codex": return new DevCodexAdapter();
    case "pi-agent": return piAgentAdapter;
    case "mock": return mockAdapter;
    default: return mockAdapter;
  }
}

async function main() {
  // Load before opening application resources. A configured but unreadable
  // shared Secret must fail startup instead of creating credential-less sandboxes.
  const baseSandboxEnv = await sandboxBaseEnvFromKubernetes(process.env);
  const sandboxEnvPolicy = sandboxEnvPolicyFromHost(process.env, baseSandboxEnv);
  if (Object.keys(baseSandboxEnv).length > 0) {
    console.log(`Shared sandbox Secret loaded: ${Object.keys(baseSandboxEnv).length} environment variables for all Agents`);
  }
  // Validate one coherent API + Sandbox storage configuration before opening resources.
  const workspaceConfig = workspaceConfigFromEnv(process.env);
  // ─── PostgreSQL (authoritative store) ─────────────────────────────────────
  const pgConfig = pgConfigFromEnv();
  const pool = createPgPool(pgConfig);
  // Fail fast if PG is unreachable.
  await pool.query("SELECT 1");
  const schema = pgConfig.schema;
  // When the schema is pre-provisioned by a migration (and the app role lacks
  // CREATE on the database), set PG_ENSURE_SCHEMA=false to skip the startup DDL.
  const ensureSchema = process.env.PG_ENSURE_SCHEMA !== "false";
  const payloads = new EventPayloadCodec(new OSSEventPayloadStore(workspaceConfig.oss));
  const stores = await createPgStores(pool, { schema, ensureSchema, payloads });
  console.log(
    `Connected to PostgreSQL (${pgConfig.connectionString ?? `${pgConfig.host ?? "127.0.0.1"}:${pgConfig.port ?? 5432}`}, schema=${schema})`,
  );

  // ─── Redis (transient per-turn deltas only) ────────────────────────────────
  // Accepted pending input is always authoritative in PostgreSQL: a Redis
  // restart must never erase a message for which the API already returned 202.
  // Redis retains only reconstructable/live turn traffic (deltas + active map).
  const redis = createRedisClient(redisConfigFromEnv());
  let turnStreamStore: TurnStreamStore | undefined;
  const pendingEventStore = stores.pendingEventStore;
  try {
    await redis.connect();
    turnStreamStore = new RedisTurnStreamStore(redis);
    console.log("Connected to Redis (delta streams + active-turn map; pending input stays in PostgreSQL)");
  } catch (err) {
    console.log(
      `Redis not reachable (${String(err)}) — pending input remains in PostgreSQL, deltas are live-only`,
    );
  }

  const eventStreamHub = new InProcessEventStreamHub();

  const artifactStore = new OSSArtifactStore(workspaceConfig.oss);
  try {
    // Read-only credential/endpoint check. No objects are created or migrated.
    await artifactStore.list("oma_startup", "storage_check");
  } catch {
    throw new Error("OSS Workspace startup check failed; verify the bucket, endpoint and Host permissions");
  }

  // Skills retain the existing Supabase client, bucket and startup configuration.
  const s3Endpoint = process.env.S3_ENDPOINT || process.env.SUPABASE_STORAGE_URL;
  const s3ServiceKey = process.env.S3_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!s3Endpoint || !s3ServiceKey) {
    throw new Error("Skills require S3_ENDPOINT (or SUPABASE_STORAGE_URL) and S3_SERVICE_KEY (or SUPABASE_SERVICE_KEY)");
  }
  const skillArtifactStore: SkillArtifactStore = new S3SkillArtifactStore({
    endpoint: s3Endpoint, serviceKey: s3ServiceKey,
    bucket: process.env.S3_BUCKET || "workspace", fetch: directFetch,
  });

  // Create a dev seed key for local testing (persisted in PG).
  await stores.apiKeyStore.create("dev", "dev-console");

  const sandboxClient = new E2BSandboxClient({
    ...workspaceConfig.sandbox,
    verifyWorkspaceProbe: async (target, probeName, expectedContent) => {
      if (target.bucket !== workspaceConfig.oss.bucket) throw new Error("Workspace bucket mismatch");
      await artifactStore.verifyWorkspaceProbe(target.prefix, probeName, expectedContent);
    },
  });
  const sandboxManager = new DefaultSandboxManager({
    sandboxClient,
    provisionSources: { s3: new S3ProvisionSource(skillArtifactStore) },
  });
  console.log("OSS Workspace enabled; Sandbox mount checks required; Skills projected from Supabase");

  const sessionRouter = new SessionRouter({
    delegationStore: stores.delegationStore,
    maxConcurrentSubagents: Number(process.env.SUBAGENT_MAX_CONCURRENT ?? 4),
    maxSubagentModelSteps: Number(process.env.SUBAGENT_MAX_MODEL_STEPS ?? 500),
    eventLogStore: stores.eventLogStore,
    pendingEventStore,
    sessionStore: stores.sessionStore,
    eventStreamHub,
    turnStreamStore,
    resolveAdapter,
    sandboxManager,
    workspaceMount: workspaceConfig.mount,
    ...sandboxEnvPolicy,
    agentStore: stores.agentStore,
    agentFileStore: stores.agentFileStore,
    skillStore: stores.skillStore,
    skillArtifactStore,
  });

  // Recover input that was accepted (202) before a previous Host process died.
  // This runs before the HTTP listener opens, so startup recovery and new
  // requests cannot race to create two local drainers for one Session.
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
    sessionShareStore: stores.sessionShareStore,
    delegationStore: stores.delegationStore,
    apiKeyStore: stores.apiKeyStore,
    fullApiKeyStore: stores.apiKeyStore,
    agentStore: stores.agentStore,
    agentFileStore: stores.agentFileStore,
    skillStore: stores.skillStore,
    skillArtifactStore,
    sessionStore: stores.sessionStore,
    eventLogStore: stores.eventLogStore,
    pendingEventStore,
    workspaceStore: stores.workspaceStore,
    loopStore: stores.loopStore,
    userStore: stores.userStore,
    artifactStore,
    eventStreamHub,
    turnStreamStore,
    sessionRouter,
  });

  const httpServer = serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`\nServer listening on http://localhost:${info.port}`);
    console.log(`AUTH_DISABLED=${process.env.AUTH_DISABLED}`);
    console.log(`Adapters: claude-code, codex, pi-agent`);
    console.log(`\nDev API key seeded (value hidden)`);
    console.log(`\nTry: curl http://localhost:${info.port}/health`);
  });

  const shutdown = createGracefulShutdown({
    server: httpServer,
    stopBackgroundWork: () => loopScheduler.stop(),
    waitForIdle: (timeoutMs) => sessionRouter.waitForIdle(timeoutMs),
    timeoutMs: Number(process.env.SHUTDOWN_GRACE_MS ?? 20_000),
    closeResources: async () => {
      try {
        await pool.end();
      } finally {
        redis.disconnect();
      }
    },
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
