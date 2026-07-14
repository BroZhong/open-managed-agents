import { serve } from "@hono/node-server";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createPgPool, pgConfigFromEnv, createPgStores, S3ArtifactStore, S3SkillArtifactStore } from "@oma-server/store";
import type { ArtifactStore, SkillArtifactStore } from "@oma-server/store";
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
  S3WorkspacePersistence,
  S3ProvisionSource,
} from "@oma-server/sandbox";
import type { SandboxManager } from "@oma-server/sandbox";
import { createApp } from "./app.js";
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
import {
  adapterProcessEnvFromHost,
  sandboxEnvPolicyFromHost,
} from "./lib/sandbox-env.js";

// Route ALL of Node's global fetch (including the Pi SDK's LLM calls) through an
// egress proxy when configured. Alibaba Cloud HK egress is geo-blocked (403) by
// OpenAI/Anthropic; the in-cluster sing-box proxy tunnels past it. Node's fetch
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
              usage: { inputTokens: event.message.usage.input_tokens, outputTokens: event.message.usage.output_tokens },
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

        if (event.type === "turn.completed" && event.usage) {
          yield {
            id: generateEventId(), timestamp: generateTimestamp(),
            type: "span.model_request_end", usage: { inputTokens: event.usage.input_tokens || 0, outputTokens: event.usage.output_tokens || 0 },
          } as SessionEvent;
        }

        if (event.type === "turn.failed" || event.type === "error") {
          hasError = true;
          yield {
            id: generateEventId(), timestamp: generateTimestamp(),
            type: "session.error", error: { message: event.error?.message || event.message || "Codex error", code: "codex_error" },
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
  // ─── PostgreSQL (authoritative store) ─────────────────────────────────────
  const pgConfig = pgConfigFromEnv();
  const pool = createPgPool(pgConfig);
  // Fail fast if PG is unreachable.
  await pool.query("SELECT 1");
  const schema = pgConfig.schema;
  // When the schema is pre-provisioned by a migration (and the app role lacks
  // CREATE on the database), set PG_ENSURE_SCHEMA=false to skip the startup DDL.
  const ensureSchema = process.env.PG_ENSURE_SCHEMA !== "false";
  const stores = await createPgStores(pool, { schema, ensureSchema });
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

  // ─── S3 artifact store (Workspace file proxy) ─────────────────────────────
  // Enabled when the Supabase Storage endpoint + service key are configured.
  let artifactStore: ArtifactStore | undefined;
  const s3Endpoint = process.env.S3_ENDPOINT || process.env.SUPABASE_STORAGE_URL;
  const s3ServiceKey = process.env.S3_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (s3Endpoint && s3ServiceKey) {
    artifactStore = new S3ArtifactStore({
      endpoint: s3Endpoint,
      serviceKey: s3ServiceKey,
      bucket: process.env.S3_BUCKET || "workspace",
      fetch: directFetch,
      // Public, browser-reachable Storage base for presigned media GETs
      // (ADR-0006 §1). The client still signs on the internal `endpoint`; this is
      // only the download base. Absent → preview-url route returns 501.
      publicBase: process.env.STORAGE_PUBLIC_BASE,
    });
    console.log(`Workspace artifact store enabled (S3 at ${s3Endpoint})`);
  } else {
    console.log("Workspace artifact store disabled — set S3_ENDPOINT + S3_SERVICE_KEY to enable");
  }

  // Skill file bodies share the S3 backend but live under a distinct
  // `<tenantId>/skills/<skillId>/…` namespace (isolated from Workspaces).
  let skillArtifactStore: SkillArtifactStore | undefined;
  if (s3Endpoint && s3ServiceKey) {
    skillArtifactStore = new S3SkillArtifactStore({
      endpoint: s3Endpoint,
      serviceKey: s3ServiceKey,
      bucket: process.env.S3_BUCKET || "workspace",
      fetch: directFetch,
    });
  }

  // Create a dev seed key for local testing (persisted in PG).
  await stores.apiKeyStore.create("dev", "dev-console");

  // Sandbox lifecycle owner (ADR-0005 §1/§2, design doc §5): a
  // DefaultSandboxManager wired with the three seams — an e2b-SDK
  // SandboxClient, S3WorkspacePersistence for the two-way Workspace (hydrate
  // from / sync back to S3), and S3ProvisionSource registered under kind "s3"
  // for read-only Skill projections (content flows S3→sandbox, never through
  // the Host; ADR-0005 §3/§4). Requires the artifact store (nothing to hydrate
  // from without it), the Skill artifact store (nothing to project without it),
  // plus E2B_DOMAIN + E2B_API_KEY. Enable with SANDBOX_ENABLED=true. A sandboxed
  // Agent with no manager fails loud (#54).
  let sandboxManager: SandboxManager | undefined;
  if (artifactStore && skillArtifactStore && process.env.SANDBOX_ENABLED === "true") {
    const sandboxClient = new E2BSandboxClient({
      domain: process.env.E2B_DOMAIN ?? "",
      apiKey: process.env.E2B_API_KEY ?? "",
      defaultTemplate: process.env.SANDBOX_TEMPLATE,
    });
    sandboxManager = new DefaultSandboxManager({
      sandboxClient,
      persistence: new S3WorkspacePersistence(artifactStore),
      provisionSources: { s3: new S3ProvisionSource(skillArtifactStore) },
    });
    console.log("SandboxManager enabled (e2b SDK, hydrate from S3, Skills projected from S3)");
  } else {
    console.log(
      "SandboxManager disabled — set SANDBOX_ENABLED=true (+ S3) to enable",
    );
  }

  // Deployment-owned CLI environment. Ordinary defaults remain overridable by
  // an Agent; managed WW values stay authoritative so a Host-held bearer token
  // cannot be redirected to an Agent-selected endpoint.
  const sandboxEnvPolicy = sandboxEnvPolicyFromHost(process.env);

  const sessionRouter = new SessionRouter({
    eventLogStore: stores.eventLogStore,
    pendingEventStore,
    sessionStore: stores.sessionStore,
    eventStreamHub,
    turnStreamStore,
    resolveAdapter,
    sandboxManager,
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

  const app = createApp({
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
