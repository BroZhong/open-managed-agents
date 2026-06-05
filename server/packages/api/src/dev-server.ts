import { serve } from "@hono/node-server";
import { MongoClient } from "mongodb";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createMongoStores } from "@oma-server/store";
import { InMemoryApiKeyStore } from "@oma-server/store-memory";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { SessionRouter } from "@oma-server/session-router";
import { OpenSandboxClient, SandboxOrchestratorImpl } from "@oma-server/sandbox";
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

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017";
const DB_NAME = process.env.DB_NAME || "oma_dev";
const PORT = parseInt(process.env.PORT || "3000", 10);
const OPENSANDBOX_URL = process.env.OPENSANDBOX_URL || "http://localhost:8080";

function readBoolEnv(name: string): boolean | undefined {
  const value = process.env[name];
  if (value == null || value === "") return undefined;
  return value === "1" || value.toLowerCase() === "true";
}

function isLocalOpenSandboxUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(url.hostname);
  } catch {
    return /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|$)/.test(value);
  }
}

function resolveOpenSandboxUseServerProxy(): boolean {
  const requested =
    readBoolEnv("OPENSANDBOX_USE_SERVER_PROXY") ??
    readBoolEnv("OPEN_SANDBOX_USE_SERVER_PROXY") ??
    false;
  if (
    requested &&
    isLocalOpenSandboxUrl(OPENSANDBOX_URL) &&
    readBoolEnv("OPENSANDBOX_ALLOW_LOCAL_SERVER_PROXY") !== true
  ) {
    console.warn(
      "Ignoring OPENSANDBOX_USE_SERVER_PROXY=true for local OpenSandbox; using direct execd endpoints. Set OPENSANDBOX_ALLOW_LOCAL_SERVER_PROXY=true to override.",
    );
    return false;
  }
  return requested;
}

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
    child.stdin.end();

    const rl = createInterface({ input: child.stdout });
    let hasError = false;

    try {
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
    child.stdin.end();

    const rl = createInterface({ input: child.stdout });
    let hasError = false;

    try {
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

// ─── Pi Agent Adapter (spawns `pi` CLI) ────────────────────────────────────

class DevPiAgentAdapter implements Adapter {
  async *run(input: AdapterInput): AsyncIterable<SessionEvent> {
    const prompt = input.message.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    const args = ["--print", "--mode", "json", "-p", prompt, "--no-session"];
    if (input.agent.model) args.push("--model", input.agent.model);

    yield { id: generateEventId(), timestamp: generateTimestamp(), type: "session.status_running" } as SessionEvent;

    const child = spawn("pi", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const rl = createInterface({ input: child.stdout });
    let hasError = false;
    let textAccumulator = "";

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        let event: any;
        try { event = JSON.parse(line); } catch { continue; }

        if (event.type === "message_update" && event.assistantMessageEvent) {
          const ame = event.assistantMessageEvent;
          if (ame.type === "text_delta" && ame.delta) {
            textAccumulator += ame.delta;
          }
          if (ame.type === "text_end") {
            textAccumulator = ame.content ?? textAccumulator;
            yield {
              id: generateEventId(), timestamp: generateTimestamp(),
              type: "agent.message", content: [{ type: "text", text: textAccumulator }],
            } as SessionEvent;
            textAccumulator = "";
          }
          if (ame.type === "toolcall_end" && ame.toolCall) {
            yield {
              id: generateEventId(), timestamp: generateTimestamp(),
              type: "agent.tool_use", toolUseId: ame.toolCall.id, name: ame.toolCall.name, input: ame.toolCall.args || {},
            } as SessionEvent;
          }
        }

        if (event.type === "tool_execution_end" && event.toolCallId) {
          yield {
            id: generateEventId(), timestamp: generateTimestamp(),
            type: "agent.tool_result", toolUseId: event.toolCallId,
            content: [{ type: "text", text: typeof event.result === "string" ? event.result : JSON.stringify(event.result) }],
            isError: event.isError ?? false,
          } as SessionEvent;
        }

        if (event.type === "message_end" && event.message?.usage) {
          yield {
            id: generateEventId(), timestamp: generateTimestamp(),
            type: "span.model_request_end", usage: { inputTokens: event.message.usage.input || 0, outputTokens: event.message.usage.output || 0 },
          } as SessionEvent;
        }
      }

      await new Promise<void>((resolve, reject) => {
        child.on("close", (code) => {
          if (code !== 0 && !hasError) reject(new Error(`pi exited with code ${code}`));
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
        type: "session.error", error: { message: String(err), code: "pi_agent_error" },
      } as SessionEvent;
    }
  }
}

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

function resolveAdapter(runtime: string): Adapter {
  switch (runtime) {
    case "claude-code": return new DevClaudeCodeAdapter();
    case "codex": return new DevCodexAdapter();
    case "pi-agent": return new DevPiAgentAdapter();
    default: return new DevMockAdapter();
  }
}

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  console.log(`Connected to MongoDB at ${MONGO_URI}/${DB_NAME}`);

  const db = client.db(DB_NAME);
  const stores = await createMongoStores(db);
  const eventStreamHub = new InProcessEventStreamHub();

  // Create a dev seed key for local testing
  const devApiKeyStore = new InMemoryApiKeyStore();
  const seedResult = await devApiKeyStore.create("dev", "dev-console");

  // Initialize sandbox orchestration (connects to local OpenSandbox if available)
  let sandboxOrchestrator: SandboxOrchestratorImpl | undefined;
  try {
    const healthRes = await fetch(`${OPENSANDBOX_URL}/health`);
    if (healthRes.ok) {
      const useServerProxy = resolveOpenSandboxUseServerProxy();
      const client = new OpenSandboxClient({
        url: OPENSANDBOX_URL,
        useServerProxy,
      });
      sandboxOrchestrator = new SandboxOrchestratorImpl(client);
      console.log(
        `Sandbox orchestration enabled (OpenSandbox at ${OPENSANDBOX_URL}, useServerProxy=${useServerProxy})`,
      );
    }
  } catch {
    console.log("OpenSandbox not available — sandbox orchestration disabled");
  }

  const sessionRouter = new SessionRouter({
    eventLogStore: stores.eventLogStore,
    pendingEventStore: stores.pendingEventStore,
    sessionStore: stores.sessionStore,
    eventStreamHub,
    resolveAdapter,
    sandboxOrchestrator,
  });

  const app = createApp({
    apiKeyStore: devApiKeyStore,
    fullApiKeyStore: devApiKeyStore,
    agentStore: stores.agentStore,
    sessionStore: stores.sessionStore,
    eventLogStore: stores.eventLogStore,
    pendingEventStore: stores.pendingEventStore,
    eventStreamHub,
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
    await client.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
