/**
 * E2E runner for Pi Agent adapter.
 * Spawns `pi` CLI in print+json mode and translates its JSONL events to SessionEvents.
 *
 * Usage:
 *   pnpm e2e:pi "What is 2+2?"
 *   pnpm e2e:pi  (defaults to "Say hello in one word")
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  generateEventId,
  generateTimestamp,
} from "@open-managed-agents/adapter-core";
import type { SessionEvent } from "@open-managed-agents/adapter-core";

interface PiMessage {
  role: string;
  content: Array<{
    type: string;
    text?: string;
    thinking?: string;
    toolCallId?: string;
    toolName?: string;
    args?: unknown;
  }>;
  model?: string;
  provider?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { total: number };
  };
  stopReason?: string;
}

interface PiStreamEvent {
  type: string;
  message?: PiMessage;
  assistantMessageEvent?: {
    type: string;
    contentIndex?: number;
    delta?: string;
    content?: string;
    toolCall?: {
      id: string;
      name: string;
      args: unknown;
    };
    partial?: PiMessage;
    reason?: string;
    message?: PiMessage;
  };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  toolResults?: Array<{ role: string; content: unknown[] }>;
  messages?: PiMessage[];
}

async function* runPiAdapter(
  prompt: string,
  options?: { model?: string; systemPrompt?: string; timeoutMs?: number }
): AsyncIterable<SessionEvent> {
  const args = ["--print", "--mode", "json", "-p", prompt, "--no-session"];

  if (options?.model) {
    args.push("--model", options.model);
  }

  yield {
    id: generateEventId(),
    timestamp: generateTimestamp(),
    type: "session.status_running",
  } as SessionEvent;

  const child = spawn("pi", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  if (options?.timeoutMs) {
    timeoutId = setTimeout(() => {
      child.kill("SIGTERM");
    }, options.timeoutMs);
  }

  const rl = createInterface({ input: child.stdout });

  let hasError = false;
  let spanStarted = false;
  let currentModel = "";
  let textAccumulator = "";
  let thinkingAccumulator = "";
  const toolUseIds = new Map<string, string>(); // toolCallId -> our generated event id

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      let event: PiStreamEvent;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }

      switch (event.type) {
        case "session":
        case "agent_start":
          break;

        case "turn_start":
          break;

        case "message_start":
          if (event.message?.role === "assistant") {
            if (!spanStarted) {
              spanStarted = true;
              currentModel =
                event.message.model ||
                event.message.provider ||
                "unknown";
              yield {
                id: generateEventId(),
                timestamp: generateTimestamp(),
                type: "span.model_request_start",
                model: currentModel,
              } as SessionEvent;
            }
            textAccumulator = "";
            thinkingAccumulator = "";
          }
          break;

        case "message_update":
          if (event.assistantMessageEvent) {
            const ame = event.assistantMessageEvent;
            switch (ame.type) {
              case "text_start":
                yield {
                  id: generateEventId(),
                  timestamp: generateTimestamp(),
                  type: "agent.message_stream_start",
                } as SessionEvent;
                break;

              case "text_delta":
                if (ame.delta) {
                  textAccumulator += ame.delta;
                  yield {
                    id: generateEventId(),
                    timestamp: generateTimestamp(),
                    type: "agent.message_chunk",
                    chunk: ame.delta,
                  } as SessionEvent;
                }
                break;

              case "text_end":
                textAccumulator = ame.content ?? textAccumulator;
                yield {
                  id: generateEventId(),
                  timestamp: generateTimestamp(),
                  type: "agent.message_stream_end",
                } as SessionEvent;
                yield {
                  id: generateEventId(),
                  timestamp: generateTimestamp(),
                  type: "agent.message",
                  message: {
                    role: "assistant",
                    content: textAccumulator,
                  },
                } as SessionEvent;
                break;

              case "thinking_start":
                yield {
                  id: generateEventId(),
                  timestamp: generateTimestamp(),
                  type: "agent.thinking_stream_start",
                } as SessionEvent;
                break;

              case "thinking_delta":
                if (ame.delta) {
                  thinkingAccumulator += ame.delta;
                  yield {
                    id: generateEventId(),
                    timestamp: generateTimestamp(),
                    type: "agent.thinking_chunk",
                    chunk: ame.delta,
                  } as SessionEvent;
                }
                break;

              case "thinking_end":
                thinkingAccumulator = ame.content ?? thinkingAccumulator;
                yield {
                  id: generateEventId(),
                  timestamp: generateTimestamp(),
                  type: "agent.thinking_stream_end",
                } as SessionEvent;
                if (thinkingAccumulator) {
                  yield {
                    id: generateEventId(),
                    timestamp: generateTimestamp(),
                    type: "agent.thinking",
                    thinking: thinkingAccumulator,
                  } as SessionEvent;
                }
                break;

              case "toolcall_start":
                yield {
                  id: generateEventId(),
                  timestamp: generateTimestamp(),
                  type: "agent.tool_use_input_stream_start",
                } as SessionEvent;
                break;

              case "toolcall_delta":
                if (ame.delta) {
                  yield {
                    id: generateEventId(),
                    timestamp: generateTimestamp(),
                    type: "agent.tool_use_input_chunk",
                    chunk: ame.delta,
                  } as SessionEvent;
                }
                break;

              case "toolcall_end":
                yield {
                  id: generateEventId(),
                  timestamp: generateTimestamp(),
                  type: "agent.tool_use_input_stream_end",
                } as SessionEvent;
                if (ame.toolCall) {
                  const toolEventId = generateEventId();
                  toolUseIds.set(ame.toolCall.id, toolEventId);
                  yield {
                    id: toolEventId,
                    timestamp: generateTimestamp(),
                    type: "agent.tool_use",
                    tool_use: {
                      id: ame.toolCall.id,
                      name: ame.toolCall.name,
                      input: ame.toolCall.args,
                    },
                  } as SessionEvent;
                }
                break;

              case "done":
              case "error":
                break;
            }
          }
          break;

        case "tool_execution_start":
          break;

        case "tool_execution_end":
          if (event.toolCallId) {
            const parentId = toolUseIds.get(event.toolCallId);
            yield {
              id: generateEventId(),
              timestamp: generateTimestamp(),
              type: "agent.tool_result",
              parent_event_id: parentId,
              tool_result: {
                tool_use_id: event.toolCallId,
                content:
                  typeof event.result === "string"
                    ? event.result
                    : JSON.stringify(event.result),
                is_error: event.isError ?? false,
              },
            } as SessionEvent;
          }
          break;

        case "message_end":
          if (event.message?.role === "assistant" && event.message.usage) {
            yield {
              id: generateEventId(),
              timestamp: generateTimestamp(),
              type: "span.model_request_end",
              model_usage: {
                input_tokens: event.message.usage.input,
                output_tokens: event.message.usage.output,
                cache_read_input_tokens: event.message.usage.cacheRead,
                cache_creation_input_tokens: event.message.usage.cacheWrite,
              },
              finish_reason: event.message.stopReason ?? "stop",
            } as SessionEvent;
            spanStarted = false;
          }
          break;

        case "turn_end":
          break;

        case "agent_end":
          break;
      }
    }

    await new Promise<void>((resolve, reject) => {
      child.on("close", (code) => {
        if (code !== 0 && !hasError) {
          reject(new Error(`pi exited with code ${code}`));
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
  console.log(`\n--- Running Pi adapter e2e with prompt: "${prompt}" ---\n`);

  for await (const event of runPiAdapter(prompt)) {
    const { id, timestamp, type, ...rest } = event as any;
    const payload = Object.keys(rest).length > 0 ? JSON.stringify(rest) : "";
    console.log(
      `[${timestamp}] ${type}${payload ? " " + payload.slice(0, 200) : ""}`
    );
  }

  console.log("\n--- Done ---");
}

main().catch(console.error);
