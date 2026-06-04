import { serve } from "@hono/node-server";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

    // Check if a session file already exists (to determine --session-id vs --resume)
    const cwd = process.cwd();
    const projectKey = cwd.replace(/\//g, "-").replace(/^-/, "");
    const sessionFile = join(homedir(), ".claude", "projects", projectKey, `${sessionUuid}.jsonl`);
    const sessionExists = existsSync(sessionFile);

    const args = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", "bypassPermissions",
      ...(sessionExists ? ["--resume", sessionUuid] : ["--session-id", sessionUuid]),
      "-p", prompt,
    ];
    if (input.agent.model && input.agent.model !== "default") args.push("--model", input.agent.model);
    if (!sessionExists && input.agent.system) args.push("--system-prompt", input.agent.system);

    yield { id: generateEventId(), timestamp: generateTimestamp(), type: "session.status_running" } as SessionEvent;

    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    child.stdin.end();

    let stderrData = "";
    child.stderr.on("data", (chunk: Buffer) => { stderrData += chunk.toString(); });

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

        if (event.type === "user" && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === "tool_result" && block.tool_use_id) {
              const text = typeof block.content === "string"
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.map((c: any) => c.text || JSON.stringify(c)).join("")
                  : JSON.stringify(block.content ?? "");
              yield {
                id: generateEventId(), timestamp: generateTimestamp(),
                type: "agent.tool_result", toolUseId: block.tool_use_id,
                content: [{ type: "text", text: text || "(empty)" }], isError: !!block.is_error,
              } as SessionEvent;
            }
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
          if (code !== 0 && !hasError) reject(new Error(`claude exited with code ${code}: ${stderrData}`));
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
    const sessionDir = `/tmp/oma-pi-sessions/${input.sessionId}`;
    const args = [
      "--print", "--mode", "json",
      "--session-dir", sessionDir,
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

// ─── OpenSandbox Client ─────────────────────────────────────────────────────

import type { SandboxClient, SandboxRef, CreateOpts } from "@oma-server/sandbox";
import { SandboxOrchestratorImpl } from "@oma-server/sandbox";

const OPENSANDBOX_URL = process.env.OPENSANDBOX_URL || "http://localhost:8080";

class OpenSandboxClient implements SandboxClient {
  private readonly baseUrl: string;
  private readonly execdPorts = new Map<string, number>(); // sandboxId → execd host port

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async create(opts: CreateOpts): Promise<SandboxRef> {
    console.log("[sandbox] Creating sandbox with image:", opts.image || "node:22-slim");
    const res = await fetch(`${this.baseUrl}/sandboxes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: { uri: opts.image || "node:22-slim" },
        timeout: opts.timeoutSeconds || 3600,
        entrypoint: ["tail", "-f", "/dev/null"],
        resourceLimits: { cpus: "1", memoryMB: "512" },
        env: opts.env,
      }),
    });
    if (!res.ok) throw new Error(`Failed to create sandbox: ${res.status} ${await res.text()}`);
    const data = await res.json() as any;
    console.log("[sandbox] Created:", data.id, "status:", data.status?.state);

    // Wait for sandbox to be ready and get execd port
    await this.waitForReady(data.id);
    await this.resolveExecdPort(data.id);

    return { sandboxId: data.id, status: "running" };
  }

  async pause(sandboxId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/sandboxes/${sandboxId}/pause`, { method: "POST" });
    if (!res.ok) throw new Error(`Failed to pause sandbox: ${res.status} ${await res.text()}`);
  }

  async resume(sandboxId: string): Promise<SandboxRef> {
    const res = await fetch(`${this.baseUrl}/sandboxes/${sandboxId}/resume`, { method: "POST" });
    if (!res.ok) throw new Error(`Failed to resume sandbox: ${res.status} ${await res.text()}`);
    await this.resolveExecdPort(sandboxId);
    return { sandboxId, status: "running" };
  }

  async kill(sandboxId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/sandboxes/${sandboxId}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw new Error(`Failed to kill sandbox: ${res.status}`);
    this.execdPorts.delete(sandboxId);
  }

  private async runCommand(sandboxId: string, cmd: string, timeoutSec = 30): Promise<{ stdout: string; exitCode: number }> {
    const port = this.execdPorts.get(sandboxId);
    if (!port) throw new Error(`No execd port for sandbox ${sandboxId}`);

    const res = await fetch(`http://127.0.0.1:${port}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: cmd, timeout: timeoutSec }),
    });
    if (!res.ok) throw new Error(`Failed to exec command: ${res.status}`);

    // Response is NDJSON stream
    const text = await res.text();
    const lines = text.split("\n").filter(l => l.trim());
    let stdout = "";
    let exitCode = 0;

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === "stdout") stdout += event.text + "\n";
        if (event.type === "stderr" && event.text) stdout += event.text + "\n";
        if (event.type === "execution_complete") exitCode = event.exit_code ?? 0;
      } catch {}
    }

    return { stdout, exitCode };
  }

  async writeFile(sandboxId: string, path: string, content: string): Promise<void> {
    const b64 = Buffer.from(content).toString("base64");
    const cmd = `echo '${b64}' | base64 -d > ${path}`;
    const { exitCode } = await this.runCommand(sandboxId, cmd);
    if (exitCode !== 0) throw new Error(`writeFile failed with exit code ${exitCode}`);
  }

  async *exec(sandboxId: string, command: string[]): AsyncIterable<string> {
    const cmd = command.join(" ");
    console.log(`[sandbox] exec: ${cmd}`);
    const { stdout, exitCode } = await this.runCommand(sandboxId, cmd, 300);
    console.log(`[sandbox] exec done: exitCode=${exitCode}, stdout=${stdout.length} bytes`);
    if (stdout) yield stdout;
    if (exitCode !== 0) throw new Error(`Command exited with code ${exitCode}`);
  }

  private async waitForReady(sandboxId: string, timeoutMs = 30000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await fetch(`${this.baseUrl}/sandboxes/${sandboxId}`);
      if (res.ok) {
        const data = await res.json() as any;
        if (data.status?.state === "Running") return;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`Sandbox ${sandboxId} did not become ready in ${timeoutMs}ms`);
  }

  private async resolveExecdPort(sandboxId: string): Promise<void> {
    // Retry a few times since execd might not be ready immediately
    for (let i = 0; i < 10; i++) {
      try {
        const res = await fetch(`${this.baseUrl}/sandboxes/${sandboxId}/endpoints/44772`);
        if (res.ok) {
          const data = await res.json() as any;
          const port = parseInt(data.endpoint.split(":")[1], 10);
          this.execdPorts.set(sandboxId, port);
          console.log(`[sandbox] execd for ${sandboxId} at port ${port}`);
          // Wait for execd to be healthy
          await this.waitForExecd(port);
          return;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error(`Failed to resolve execd port for sandbox ${sandboxId}`);
  }

  private async waitForExecd(port: number): Promise<void> {
    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          console.log(`[sandbox] execd health OK on port ${port}`);
          return;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`execd on port ${port} not healthy after 10s`);
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

  // Initialize sandbox orchestration (connects to local OpenSandbox if available)
  let sandboxOrchestrator: SandboxOrchestratorImpl | undefined;
  try {
    const healthRes = await fetch(`${OPENSANDBOX_URL}/health`);
    if (healthRes.ok) {
      const client = new OpenSandboxClient(OPENSANDBOX_URL);
      sandboxOrchestrator = new SandboxOrchestratorImpl(client);
      console.log(`Sandbox orchestration enabled (OpenSandbox at ${OPENSANDBOX_URL})`);
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
