import { serve } from "@hono/node-server";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { createMemoryStores } from "@oma-server/store-memory";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { SessionRouter } from "@oma-server/session-router";
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

const PORT = parseInt(process.env.PORT || "3000", 10);

process.env.AUTH_DISABLED = process.env.AUTH_DISABLED || "true";

// ─── Claude Code Adapter (spawns `claude` CLI) ──────────────────────────────

class DevClaudeCodeAdapter implements Adapter {
  async *run(input: AdapterInput): AsyncIterable<SessionEvent> {
    const prompt = input.message.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    const isFirstTurn = input.history.length === 0;
    // Generate a deterministic UUID from sessionId for claude's --session-id
    const hash = createHash("md5").update(input.sessionId).digest("hex");
    const sessionUuid = `${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}`;
    const args = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", "bypassPermissions",
      ...(isFirstTurn ? ["--session-id", sessionUuid] : ["--resume", sessionUuid]),
      "-p", prompt,
    ];
    if (input.agent.model && input.agent.model !== "default") args.push("--model", input.agent.model);
    if (isFirstTurn && input.agent.system) args.push("--system-prompt", input.agent.system);

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
            } else if (block.type === "tool_use") {
              yield {
                id: generateEventId(), timestamp: generateTimestamp(),
                type: "agent.tool_use", toolUseId: block.id || "", name: block.name || "unknown", input: block.input || {},
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

        if (event.type === "user" && event.parent_tool_use_id && event.message?.content) {
          const resultContent = event.message.content
            .map((b: any) => typeof b === "string" ? b : b.type === "tool_result" ? (typeof b.content === "string" ? b.content : JSON.stringify(b.content)) : b.text || JSON.stringify(b))
            .join("");
          yield {
            id: generateEventId(), timestamp: generateTimestamp(),
            type: "agent.tool_result", toolUseId: event.parent_tool_use_id,
            content: [{ type: "text", text: resultContent || "(empty)" }], isError: false,
          } as SessionEvent;
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

    // Build context from history for multi-turn
    let fullPrompt = prompt;
    if (input.history.length > 0) {
      const context = input.history
        .filter((e: any) => e.type === "user.message" || e.type === "agent.message")
        .map((e: any) => {
          if (e.type === "user.message") {
            const text = e.content?.map((c: any) => c.text).join("") || "";
            return `User: ${text}`;
          }
          const text = e.content?.map((c: any) => c.text).join("") || "";
          return `Assistant: ${text}`;
        })
        .join("\n\n");
      fullPrompt = `<conversation_history>\n${context}\n</conversation_history>\n\nUser: ${prompt}`;
    }

    const args = ["exec", "--json", "-s", "danger-full-access", "--", fullPrompt];

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

    const isFirstTurn = input.history.length === 0;
    const args = [
      "--print", "--mode", "json",
      "--session", input.sessionId,
      ...(isFirstTurn ? [] : ["--continue"]),
      "-p", prompt,
    ];
    if (input.agent.model && input.agent.model !== "default") args.push("--model", input.agent.model);

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
  const stores = createMemoryStores();
  const eventStreamHub = new InProcessEventStreamHub();

  // Create a dev seed key so auth can be tested
  const seedResult = await stores.apiKeyStore.create("dev", "dev-console");

  const sessionRouter = new SessionRouter({
    eventLogStore: stores.eventLogStore,
    pendingEventStore: stores.pendingEventStore,
    sessionStore: stores.sessionStore,
    eventStreamHub,
    resolveAdapter,
  });

  const app = createApp({
    apiKeyStore: stores.apiKeyStore,
    fullApiKeyStore: stores.apiKeyStore,
    agentStore: stores.agentStore,
    sessionStore: stores.sessionStore,
    eventLogStore: stores.eventLogStore,
    pendingEventStore: stores.pendingEventStore,
    eventStreamHub,
    sessionRouter,
  });

  serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`\nServer listening on http://localhost:${info.port}`);
    console.log(`Storage: in-memory (no MongoDB required)`);
    console.log(`AUTH_DISABLED=${process.env.AUTH_DISABLED}`);
    console.log(`Adapters: claude-code, codex, pi-agent`);
    console.log(`\nDev API key: ${seedResult.rawKey}`);
    console.log(`\nTry: curl http://localhost:${info.port}/health`);
  });
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
