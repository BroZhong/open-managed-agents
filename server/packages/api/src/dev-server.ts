import { serve } from "@hono/node-server";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createPgPool, pgConfigFromEnv, createPgStores, S3ArtifactStore } from "@oma-server/store";
import type { ArtifactStore } from "@oma-server/store";
import {
  createRedisClient,
  redisConfigFromEnv,
  RedisTurnStreamStore,
  RedisPendingEventStore,
} from "@oma-server/redis";
import type { TurnStreamStore } from "@oma-server/redis";
import type { PendingEventStore } from "@oma-server/store";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { SessionRouter } from "@oma-server/session-router";
import { KruiseSandboxClient, SandboxToolExecutorFactory } from "@oma-server/sandbox";
import type { ToolExecutorFactory } from "@oma-server/sandbox";
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
import { PiAgentAdapter } from "@open-managed-agents/adapter-pi-agent";

const PORT = parseInt(process.env.PORT || "3000", 10);

process.env.AUTH_DISABLED = process.env.AUTH_DISABLED || "true";

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
      env: process.env,
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
      env: process.env,
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

class DevMockAdapter implements Adapter {
  async *run(input: AdapterInput): AsyncIterable<SessionEvent> {
    const text = input.message.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    yield { id: generateEventId(), timestamp: generateTimestamp(), type: "session.status_running" } as SessionEvent;
    yield {
      id: generateEventId(), timestamp: generateTimestamp(),
      type: "agent.message", content: [{ type: "text", text: `[mock echo] ${text}` }],
    } as SessionEvent;
    yield { id: generateEventId(), timestamp: generateTimestamp(), type: "session.status_idle" } as SessionEvent;
  }
}

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
    case "mock": return new DevMockAdapter();
    default: return new DevMockAdapter();
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

  // ─── Redis (transient traffic: pending queue + per-turn delta streams) ────
  // When Redis is reachable, the pending-input queue and per-turn delta streams
  // + active-turn map live in Redis (ADR-0002 §3). When it is not, fall back to
  // the PostgreSQL pending queue and live-only deltas (no reconnect backfill).
  const redis = createRedisClient(redisConfigFromEnv());
  let turnStreamStore: TurnStreamStore | undefined;
  let pendingEventStore: PendingEventStore = stores.pendingEventStore;
  try {
    await redis.connect();
    turnStreamStore = new RedisTurnStreamStore(redis);
    pendingEventStore = new RedisPendingEventStore(redis);
    console.log("Connected to Redis (pending queue + delta streams + active-turn map)");
  } catch (err) {
    console.log(
      `Redis not reachable (${String(err)}) — falling back to PostgreSQL pending queue, live-only deltas`,
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
    });
    console.log(`Workspace artifact store enabled (S3 at ${s3Endpoint})`);
  } else {
    console.log("Workspace artifact store disabled — set S3_ENDPOINT + S3_SERVICE_KEY to enable");
  }

  // Create a dev seed key for local testing (persisted in PG).
  const seedResult = await stores.apiKeyStore.create("dev", "dev-console");

  // Sandbox-backed ToolExecutor factory (ADR-0002 §4): kruise-CRD sandboxes,
  // hydrated from the S3 Workspace. Requires the artifact store (nothing to
  // hydrate from without it). Enable with SANDBOX_ENABLED=true.
  let toolExecutorFactory: ToolExecutorFactory | undefined;
  if (artifactStore && process.env.SANDBOX_ENABLED === "true") {
    const sandboxClient = new KruiseSandboxClient({
      namespace: process.env.SANDBOX_NAMESPACE,
      defaultImage: process.env.SANDBOX_IMAGE,
    });
    toolExecutorFactory = new SandboxToolExecutorFactory({
      sandboxClient,
      artifactStore,
    });
    console.log("Sandbox ToolExecutor enabled (kruise CRD, hydrate from S3)");
  } else {
    console.log(
      "Sandbox ToolExecutor disabled — set SANDBOX_ENABLED=true (+ S3) to enable",
    );
  }

  const sessionRouter = new SessionRouter({
    eventLogStore: stores.eventLogStore,
    pendingEventStore,
    sessionStore: stores.sessionStore,
    eventStreamHub,
    turnStreamStore,
    resolveAdapter,
    toolExecutorFactory,
  });

  const app = createApp({
    apiKeyStore: stores.apiKeyStore,
    fullApiKeyStore: stores.apiKeyStore,
    agentStore: stores.agentStore,
    sessionStore: stores.sessionStore,
    eventLogStore: stores.eventLogStore,
    pendingEventStore,
    workspaceStore: stores.workspaceStore,
    artifactStore,
    eventStreamHub,
    turnStreamStore,
    sessionRouter,
  });

  serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`\nServer listening on http://localhost:${info.port}`);
    console.log(`AUTH_DISABLED=${process.env.AUTH_DISABLED}`);
    console.log(`Adapters: claude-code, codex, pi-agent`);
    console.log(`\nDev API key: ${seedResult.rawKey}`);
    console.log(`\nTry: curl http://localhost:${info.port}/health`);
  });

  process.on("SIGINT", async () => {
    await pool.end().catch(() => {});
    redis.disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
