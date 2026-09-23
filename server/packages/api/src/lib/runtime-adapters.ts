import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Adapter, AdapterInput, SessionEvent } from "@open-managed-agents/adapter-core";
import { generateEventId, generateTimestamp } from "@open-managed-agents/adapter-core";
import { MockAdapter } from "@open-managed-agents/adapter-mock";
import { PiAgentAdapter } from "@open-managed-agents/adapter-pi-agent";
import { adapterProcessEnvFromHost } from "./sandbox-env.js";
import { translateDevCodexTerminalEvent } from "./dev-codex-events.js";
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
const mockAdapter = new MockAdapter({ delayMs: Number(process.env.MOCK_DELAY_MS ?? 75) });

// ─── Main ───────────────────────────────────────────────────────────────────

// The Pi adapter is the real SDK-based one (@open-managed-agents/adapter-pi-agent):
// it reads the per-run ToolExecutor from AdapterInput.toolExecutor (injected by
// the SessionRouter) and, when present, registers custom tools that proxy into
// it (ADR-0002 §2). A single instance is fine — all per-turn state is per-call.
const piAgentAdapter = new PiAgentAdapter();

export function resolveAdapter(runtime: string): Adapter {
  switch (runtime) {
    case "claude-code": return new DevClaudeCodeAdapter();
    case "codex": return new DevCodexAdapter();
    case "pi-agent": return piAgentAdapter;
    case "mock": return mockAdapter;
    default: return mockAdapter;
  }
}

