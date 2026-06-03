/**
 * E2E runner: spawns `claude` CLI as a subprocess with Bedrock config,
 * pipes stream-json output through the adapter's translator, and emits SessionEvents.
 *
 * Usage:
 *   npx tsx adapter/e2e/run.ts "What is 2+2?"
 *   npx tsx adapter/e2e/run.ts  (defaults to "Say hello in one word")
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  generateEventId,
  generateTimestamp,
} from "../packages/core/src/index.js";
import type { SessionEvent } from "../packages/core/src/index.js";

interface CliStreamEvent {
  type: string;
  subtype?: string;
  message?: {
    id: string;
    model: string;
    role: string;
    content: Array<{
      type: string;
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      content?: string;
      is_error?: boolean;
    }>;
    stop_reason: string | null;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  result?: string;
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: Record<string, unknown>;
  session_id?: string;
  [key: string]: unknown;
}

async function* runClaudeAdapter(
  prompt: string,
  options?: { model?: string; systemPrompt?: string; timeoutMs?: number }
): AsyncIterable<SessionEvent> {
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    "bypassPermissions",
    "-p",
    prompt,
  ];

  if (options?.model) {
    args.push("--model", options.model);
  }

  if (options?.systemPrompt) {
    args.push("--system-prompt", options.systemPrompt);
  }

  // Yield session.status_running
  yield {
    id: generateEventId(),
    timestamp: generateTimestamp(),
    type: "session.status_running",
  } as SessionEvent;

  const child = spawn("claude", args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      // Bedrock config is inherited from ~/.claude/settings.json env vars
    },
  });

  // Set up timeout
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  if (options?.timeoutMs) {
    timeoutId = setTimeout(() => {
      child.kill("SIGTERM");
    }, options.timeoutMs);
  }

  const rl = createInterface({ input: child.stdout });

  let spanStarted = false;
  let hasError = false;
  const pendingMcpToolUseIds = new Map<string, string>();

  // Track partial message state for streaming delta support.
  // With --include-partial-messages, the CLI emits multiple `assistant` events
  // for the same in-progress message, each containing all content blocks accumulated
  // so far. We diff against prior state to emit only new chunks/blocks.
  let lastMessageId: string | null = null;
  let emittedTextLength = 0;
  let emittedThinkingLength = 0;
  let emittedBlockCount = 0;
  let streamingText = false;
  let streamingThinking = false;

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      let event: CliStreamEvent;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }

      // Skip system/hook events
      if (event.type === "system") continue;

      // Assistant message — this is the main model response (or partial update)
      if (event.type === "assistant" && event.message) {
        const msgId = event.message.id;
        const isNewMessage = msgId !== lastMessageId;
        const isComplete = event.message.stop_reason !== null;

        if (isNewMessage) {
          // Close any open streams from the previous message
          if (streamingText) {
            yield { id: generateEventId(), timestamp: generateTimestamp(), type: "agent.message_stream_end" } as SessionEvent;
            streamingText = false;
          }
          if (streamingThinking) {
            yield { id: generateEventId(), timestamp: generateTimestamp(), type: "agent.thinking_stream_end" } as SessionEvent;
            streamingThinking = false;
          }
          lastMessageId = msgId;
          emittedTextLength = 0;
          emittedThinkingLength = 0;
          emittedBlockCount = 0;
        }

        if (!spanStarted) {
          spanStarted = true;
          yield {
            id: generateEventId(),
            timestamp: generateTimestamp(),
            type: "span.model_request_start",
            model: event.message.model,
          } as SessionEvent;
        }

        // Process content blocks — emit deltas for text/thinking, full events for tool_use
        const blocks = event.message.content;
        for (let i = 0; i < blocks.length; i++) {
          const block = blocks[i]!;

          if (block.type === "text") {
            const fullText = block.text ?? "";
            if (fullText.length > emittedTextLength) {
              if (!streamingText) {
                streamingText = true;
                yield { id: generateEventId(), timestamp: generateTimestamp(), type: "agent.message_stream_start" } as SessionEvent;
              }
              const delta = fullText.slice(emittedTextLength);
              yield { id: generateEventId(), timestamp: generateTimestamp(), type: "agent.message_chunk", text: delta } as SessionEvent;
              emittedTextLength = fullText.length;
            }
          } else if (block.type === "thinking") {
            const fullThinking = block.thinking ?? "";
            if (fullThinking.length > emittedThinkingLength) {
              if (!streamingThinking) {
                streamingThinking = true;
                yield { id: generateEventId(), timestamp: generateTimestamp(), type: "agent.thinking_stream_start" } as SessionEvent;
              }
              const delta = fullThinking.slice(emittedThinkingLength);
              yield { id: generateEventId(), timestamp: generateTimestamp(), type: "agent.thinking_chunk", text: delta } as SessionEvent;
              emittedThinkingLength = fullThinking.length;
            }
          } else if (block.type === "tool_use" && i >= emittedBlockCount) {
            // Tool use blocks are emitted once when they first appear
            const isMcp = block.name?.startsWith("mcp__") ?? false;
            if (isMcp && block.id) {
              const serverName = block.name!.split("__")[1] ?? "";
              pendingMcpToolUseIds.set(block.id, serverName);
            }

            let input: Record<string, unknown> = {};
            if (block.input) {
              input =
                typeof block.input === "string"
                  ? JSON.parse(block.input)
                  : (block.input as Record<string, unknown>);
            }

            if (isMcp) {
              const serverName = block.name!.split("__")[1] ?? "";
              yield {
                id: generateEventId(),
                timestamp: generateTimestamp(),
                type: "agent.mcp_tool_use",
                toolUseId: block.id ?? "",
                serverName,
                name: block.name!,
                input,
              } as SessionEvent;
            } else {
              yield {
                id: generateEventId(),
                timestamp: generateTimestamp(),
                type: "agent.tool_use",
                toolUseId: block.id ?? "",
                name: block.name ?? "",
                input,
              } as SessionEvent;
            }
            emittedBlockCount = i + 1;
          }
        }

        // On final message: close streams and emit canonical events
        if (isComplete) {
          if (streamingThinking) {
            yield { id: generateEventId(), timestamp: generateTimestamp(), type: "agent.thinking_stream_end" } as SessionEvent;
            streamingThinking = false;
          }
          if (streamingText) {
            yield { id: generateEventId(), timestamp: generateTimestamp(), type: "agent.message_stream_end" } as SessionEvent;
            streamingText = false;
          }

          // Emit canonical events for the completed message
          for (const block of blocks) {
            if (block.type === "text" && block.text) {
              yield {
                id: generateEventId(),
                timestamp: generateTimestamp(),
                type: "agent.message",
                content: [{ type: "text", text: block.text }],
              } as SessionEvent;
            } else if (block.type === "thinking" && block.thinking) {
              yield {
                id: generateEventId(),
                timestamp: generateTimestamp(),
                type: "agent.thinking",
                text: block.thinking,
              } as SessionEvent;
            }
          }

          if (event.message.usage) {
            yield {
              id: generateEventId(),
              timestamp: generateTimestamp(),
              type: "span.model_request_end",
              model_usage: {
                input_tokens: event.message.usage.input_tokens,
                output_tokens: event.message.usage.output_tokens,
                cache_creation_input_tokens:
                  event.message.usage.cache_creation_input_tokens,
                cache_read_input_tokens:
                  event.message.usage.cache_read_input_tokens,
              },
              finish_reason: event.message.stop_reason,
            } as SessionEvent;
          }
          spanStarted = false;
        }
      }

      // User message — contains tool results
      if (event.type === "user" && event.message) {
        for (const block of event.message.content) {
          if (block.type === "tool_result") {
            const isMcp = block.tool_use_id
              ? pendingMcpToolUseIds.has(block.tool_use_id)
              : false;
            yield {
              id: generateEventId(),
              timestamp: generateTimestamp(),
              type: isMcp ? "agent.mcp_tool_result" : "agent.tool_result",
              toolUseId: block.tool_use_id ?? "",
              content: [{ type: "text", text: block.content ?? "" }],
              isError: block.is_error ?? false,
              ...(isMcp && {
                serverName: pendingMcpToolUseIds.get(block.tool_use_id!) ?? "",
              }),
            } as SessionEvent;
          }
        }
      }

      // Result event — turn is complete
      if (event.type === "result") {
        if (event.subtype === "error" || event.is_error) {
          hasError = true;
          yield {
            id: generateEventId(),
            timestamp: generateTimestamp(),
            type: "session.error",
            error: {
              message: event.result ?? "Unknown error",
              code: "sdk_error",
            },
          } as SessionEvent;
        }
      }
    }

    // Wait for child to exit
    await new Promise<void>((resolve, reject) => {
      child.on("close", (code) => {
        if (code !== 0 && !hasError) {
          reject(new Error(`claude exited with code ${code}`));
        } else {
          resolve();
        }
      });
      child.on("error", reject);
    });

    if (!hasError) {
      yield {
        id: generateEventId(),
        timestamp: generateTimestamp(),
        type: "session.status_idle",
      } as SessionEvent;
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    yield {
      id: generateEventId(),
      timestamp: generateTimestamp(),
      type: "session.error",
      error: { message: msg, code: "sdk_error" },
    } as SessionEvent;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// --- Main ---
async function main() {
  const prompt = process.argv[2] || "Say hello in one word";
  console.log(`\n--- Running adapter e2e with prompt: "${prompt}" ---\n`);

  for await (const event of runClaudeAdapter(prompt, {
    systemPrompt: "You are a helpful assistant. Be concise.",
  })) {
    const { id, timestamp, type, ...rest } = event as any;
    const payload = Object.keys(rest).length > 0 ? JSON.stringify(rest) : "";
    console.log(
      `[${timestamp}] ${type}${payload ? " " + payload.slice(0, 200) : ""}`
    );
  }

  console.log("\n--- Done ---");
}

main().catch(console.error);
