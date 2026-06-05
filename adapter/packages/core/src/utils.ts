import { nanoid } from "nanoid";
import type { ContentBlock, SessionEvent } from "./types.js";

/**
 * Generate a unique event ID with `sevt_` prefix.
 */
export function generateEventId(): string {
  return `sevt_${nanoid(21)}`;
}

/**
 * Generate an ISO 8601 timestamp for the current instant.
 */
export function generateTimestamp(): string {
  return new Date().toISOString();
}

// ─── Type guards ─────────────────────────────────────────────────────────────

const LIFECYCLE_TYPES: ReadonlySet<string> = new Set([
  "session.status_running",
  "session.status_idle",
  "session.error",
]);

const SPAN_TYPES: ReadonlySet<string> = new Set([
  "span.model_request_start",
  "span.model_first_token",
  "span.model_request_end",
]);

const CANONICAL_TYPES: ReadonlySet<string> = new Set([
  "agent.message",
  "agent.thinking",
  "agent.tool_use",
  "agent.tool_result",
  "agent.mcp_tool_use",
  "agent.mcp_tool_result",
]);

const STREAM_TYPES: ReadonlySet<string> = new Set([
  "agent.message_stream_start",
  "agent.message_chunk",
  "agent.message_stream_end",
  "agent.thinking_stream_start",
  "agent.thinking_chunk",
  "agent.thinking_stream_end",
  "agent.tool_use_input_stream_start",
  "agent.tool_use_input_chunk",
  "agent.tool_use_input_stream_end",
]);

export function isLifecycleEvent(event: SessionEvent): boolean {
  return LIFECYCLE_TYPES.has(event.type);
}

export function isSpanEvent(event: SessionEvent): boolean {
  return SPAN_TYPES.has(event.type);
}

export function isCanonicalEvent(event: SessionEvent): boolean {
  return CANONICAL_TYPES.has(event.type);
}

export function isStreamEvent(event: SessionEvent): boolean {
  return STREAM_TYPES.has(event.type);
}

export function textFromContentBlocks(blocks: ContentBlock[] | undefined): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export function buildPromptWithHistory(
  prompt: string,
  history: SessionEvent[],
): string {
  const lines = history
    .map((event) => {
      const record = event as unknown as {
        type: string;
        content?: ContentBlock[];
        data?: { content?: ContentBlock[] };
      };
      if (record.type === "user.message") {
        const text = textFromContentBlocks(record.content ?? record.data?.content);
        return text ? `User: ${text}` : "";
      }
      if (record.type === "agent.message") {
        const text = textFromContentBlocks(record.content ?? record.data?.content);
        return text ? `Assistant: ${text}` : "";
      }
      return "";
    })
    .filter(Boolean);

  if (lines.length === 0) return prompt;

  return `<conversation_history>\n${lines.join("\n\n")}\n</conversation_history>\n\nUser: ${prompt}`;
}
