import type {
  SessionErrorEvent,
  SpanModelRequestEndEvent,
  TokenUsage,
} from "@open-managed-agents/adapter-core";

export type DevCodexTerminalEvent =
  | Omit<SpanModelRequestEndEvent, "id" | "timestamp">
  | Omit<SessionErrorEvent, "id" | "timestamp">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function translateUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined;

  return {
    inputTokens: tokenCount(value.input_tokens),
    outputTokens: tokenCount(value.output_tokens),
    cacheReadTokens: tokenCount(value.cached_input_tokens),
    cacheWriteTokens: 0,
  };
}

function errorMessage(event: Record<string, unknown>): string {
  const nestedError = event.error;
  if (isRecord(nestedError) && typeof nestedError.message === "string" && nestedError.message) {
    return nestedError.message;
  }
  if (typeof event.message === "string" && event.message) return event.message;
  return "Codex error";
}

/**
 * Converts Codex CLI terminal events into metadata-free Session events.
 * Callers add their own event id and timestamp before yielding them.
 */
export function translateDevCodexTerminalEvent(event: unknown): DevCodexTerminalEvent[] {
  if (!isRecord(event)) return [];

  const usage = translateUsage(event.usage);
  if (event.type === "turn.completed") {
    return usage ? [{ type: "span.model_request_end", usage }] : [];
  }

  if (event.type !== "turn.failed" && event.type !== "error") return [];

  const translated: DevCodexTerminalEvent[] = [];
  if (usage) translated.push({ type: "span.model_request_end", usage });
  translated.push({
    type: "session.error",
    error: { message: errorMessage(event), code: "codex_error" },
  });
  return translated;
}
