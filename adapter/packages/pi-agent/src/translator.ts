import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SessionEvent } from "@open-managed-agents/adapter-core";
import {
  generateEventId,
  generateTimestamp,
} from "@open-managed-agents/adapter-core";

/**
 * Translate Pi SDK `AgentSessionEvent`s (from `session.subscribe()`) into the
 * canonical adapter {@link SessionEvent} union.
 *
 * Lifecycle wrapping (session.status_running / status_idle) and error handling
 * are the adapter's responsibility, not this translator's — it maps the
 * model/tool/thinking stream events one turn at a time and is stateful across
 * calls within a single run (it accumulates streamed text/thinking and
 * correlates tool-call ids to their emitted event ids).
 */
export class PiEventTranslator {
  private spanStarted = false;
  private currentModel = "";
  private currentProvider = "";
  private currentApi = "";
  private textAccumulator = "";
  private thinkingAccumulator = "";
  private pendingProviderError: string | undefined;
  /**
   * How many of the current assistant message's text blocks already became an
   * `agent.message`. Pi emits `text_end` per finished text block, but an
   * Interrupt cuts the stream off before it — only `message_end` arrives. The
   * count tells `message_end` which text blocks are still unaccounted for so it
   * can compensate with exactly one message and never duplicate a finished one.
   */
  private emittedTextBlocks = 0;

  processEvent(event: AgentSessionEvent): SessionEvent[] {
    const events: SessionEvent[] = [];

    switch (event.type) {
      case "message_start": {
        if (event.message.role === "assistant") {
          if (!this.spanStarted) {
            this.spanStarted = true;
            const msg = event.message as {
              model?: string;
              provider?: string;
              api?: string;
            };
            this.currentModel = msg.model || msg.provider || "unknown";
            // Capture the origin model metadata so `agent.message` can carry it
            // (ADR-0003): a later per-turn history rebuild uses provider/api/model
            // to keep tool-call ids byte-stable for same-model turns.
            this.currentProvider = msg.provider ?? "";
            this.currentApi = msg.api ?? "";
            events.push({
              id: generateEventId(),
              timestamp: generateTimestamp(),
              type: "span.model_request_start",
              model: this.currentModel,
            } as SessionEvent);
          }
          this.textAccumulator = "";
          this.thinkingAccumulator = "";
          this.emittedTextBlocks = 0;
        }
        break;
      }

      case "message_update": {
        const ame = event.assistantMessageEvent;
        switch (ame.type) {
          case "text_start":
            // A new text block starts empty; the accumulator must not carry the
            // previous block's text into it (matters when an Interrupt lands on
            // the second block and `message_end` has to compensate).
            this.textAccumulator = "";
            events.push({
              id: generateEventId(),
              timestamp: generateTimestamp(),
              type: "agent.message_stream_start",
            } as SessionEvent);
            break;

          case "text_delta":
            if (ame.delta) {
              this.textAccumulator += ame.delta;
              events.push({
                id: generateEventId(),
                timestamp: generateTimestamp(),
                type: "agent.message_chunk",
                text: ame.delta,
              } as SessionEvent);
            }
            break;

          case "text_end":
            this.textAccumulator = ame.content ?? this.textAccumulator;
            events.push({
              id: generateEventId(),
              timestamp: generateTimestamp(),
              type: "agent.message_stream_end",
            } as SessionEvent);
            events.push(this.makeMessageEvent(this.textAccumulator));
            this.emittedTextBlocks++;
            // The block is now durable; anything left in the accumulator would
            // be mistaken for unfinished text by a later `message_end`.
            this.textAccumulator = "";
            break;

          case "thinking_start":
            events.push({
              id: generateEventId(),
              timestamp: generateTimestamp(),
              type: "agent.thinking_stream_start",
            } as SessionEvent);
            break;

          case "thinking_delta":
            if (ame.delta) {
              this.thinkingAccumulator += ame.delta;
              events.push({
                id: generateEventId(),
                timestamp: generateTimestamp(),
                type: "agent.thinking_chunk",
                text: ame.delta,
              } as SessionEvent);
            }
            break;

          case "thinking_end":
            this.thinkingAccumulator = ame.content ?? this.thinkingAccumulator;
            events.push({
              id: generateEventId(),
              timestamp: generateTimestamp(),
              type: "agent.thinking_stream_end",
            } as SessionEvent);
            if (this.thinkingAccumulator) {
              events.push({
                id: generateEventId(),
                timestamp: generateTimestamp(),
                type: "agent.thinking",
                text: this.thinkingAccumulator,
              } as SessionEvent);
            }
            break;

          case "toolcall_start": {
            // The SDK already carries the tool call's id/name at stream start —
            // they live in `partial.content[contentIndex]` (the ToolCall block,
            // with args still filling in). Surface them so streamed input chunks
            // can be attributed to a specific call even when several run at once.
            const tc = toolCallAt(ame.partial, ame.contentIndex);
            events.push({
              id: generateEventId(),
              timestamp: generateTimestamp(),
              type: "agent.tool_use_input_stream_start",
              toolUseId: tc?.id ?? "",
              name: tc?.name ?? "",
            } as SessionEvent);
            break;
          }

          case "toolcall_delta":
            if (ame.delta) {
              const tc = toolCallAt(ame.partial, ame.contentIndex);
              events.push({
                id: generateEventId(),
                timestamp: generateTimestamp(),
                type: "agent.tool_use_input_chunk",
                toolUseId: tc?.id ?? "",
                delta: ame.delta,
              } as SessionEvent);
            }
            break;

          case "toolcall_end": {
            const tc = toolCallAt(ame.partial, ame.contentIndex);
            events.push({
              id: generateEventId(),
              timestamp: generateTimestamp(),
              type: "agent.tool_use_input_stream_end",
              toolUseId: tc?.id ?? "",
            } as SessionEvent);
            const toolCall = ame.toolCall;
            if (toolCall) {
              events.push({
                id: generateEventId(),
                timestamp: generateTimestamp(),
                type: "agent.tool_use",
                toolUseId: toolCall.id,
                name: toolCall.name,
                input:
                  typeof toolCall.arguments === "object" &&
                  toolCall.arguments !== null
                    ? (toolCall.arguments as Record<string, unknown>)
                    : {},
              } as SessionEvent);
            }
            break;
          }
        }
        break;
      }

      case "tool_execution_end": {
        // Pair on the provider's tool-call id (ADR-0003): the same id the
        // matching `agent.tool_use` carries in its `toolUseId`. This makes the
        // event log self-describing — `toolCall.id` ↔ `toolResult.toolCallId`
        // survives a history rebuild — and lets consumers link result→use by id.
        events.push({
          id: generateEventId(),
          timestamp: generateTimestamp(),
          type: "agent.tool_result",
          toolUseId: event.toolCallId,
          content: [
            {
              type: "text",
              text: normalizeResult(event.result),
            },
          ],
          isError: event.isError ?? false,
        } as SessionEvent);
        break;
      }

      case "message_end": {
        if (event.message.role === "assistant") {
          const message = event.message as {
            usage?: { input: number; output: number };
            stopReason?: string;
            errorMessage?: string;
            content?: unknown;
          };
          const usage = message.usage;
          if (this.spanStarted && usage) {
            this.spanStarted = false;
            events.push({
              id: generateEventId(),
              timestamp: generateTimestamp(),
              type: "span.model_request_end",
              usage: {
                inputTokens: usage.input,
                outputTokens: usage.output,
              },
            } as SessionEvent);
          }
          // An Interrupt cuts the stream off before `text_end`, so the text Pi
          // already produced would vanish: the deltas are transient and no
          // Complete Event was ever emitted. `message_end` still carries the
          // message, so compensate here with the text no `text_end` claimed and
          // tag it with the stop reason — that is what makes an Interrupted
          // Turn's half-written output durable history (issue #110).
          const unemitted = this.unemittedText(message.content);
          if (unemitted) {
            events.push(
              this.makeMessageEvent(
                unemitted,
                message.stopReason === "stop" ? undefined : message.stopReason,
              ),
            );
            this.emittedTextBlocks++;
          }
          this.pendingProviderError =
            message.stopReason === "error"
              ? message.errorMessage?.trim() || "Pi provider request failed"
              : undefined;
        }
        break;
      }

      // Lifecycle / non-content events are handled by the adapter wrapper
      // (agent_start/agent_end) or are irrelevant to the canonical stream.
      default:
        break;
    }

    return events;
  }

  /**
   * Build one `agent.message` Complete Event carrying the current assistant
   * message's origin metadata. `stopReason` is set only when the message did not
   * finish normally, keeping the field absent on the overwhelmingly common path.
   */
  private makeMessageEvent(text: string, stopReason?: string): SessionEvent {
    return {
      id: generateEventId(),
      timestamp: generateTimestamp(),
      type: "agent.message",
      content: [{ type: "text", text }],
      ...(this.currentProvider ? { provider: this.currentProvider } : {}),
      ...(this.currentApi ? { api: this.currentApi } : {}),
      // The raw origin model id (not the `model || provider` fallback used for
      // the span event) so it round-trips into history.
      ...(this.currentModel && this.currentModel !== "unknown"
        ? { model: this.currentModel }
        : {}),
      ...(stopReason ? { stopReason } : {}),
    } as SessionEvent;
  }

  /**
   * The text of this assistant message that no `agent.message` covers yet.
   *
   * Prefer `message_end`'s own content blocks (authoritative, and present even
   * when the stream never reached `text_end`), skipping the blocks already
   * emitted; fall back to the delta accumulator when the message carries no
   * usable content array.
   */
  private unemittedText(content: unknown): string {
    if (Array.isArray(content)) {
      const texts = content
        .filter(
          (block): block is { type: "text"; text: string } =>
            !!block &&
            typeof block === "object" &&
            (block as { type?: unknown }).type === "text" &&
            typeof (block as { text?: unknown }).text === "string",
        )
        .map((block) => block.text);
      if (texts.length > 0) {
        return texts.slice(this.emittedTextBlocks).join("");
      }
    }
    return this.textAccumulator;
  }

  /**
   * Finish one session.prompt() translation after its event queue has drained.
   *
   * Pi represents provider failures as assistant messages with
   * `stopReason: "error"`. Neither value of agent_end.willRetry proves that the
   * whole prompt is over: automatic retries use true, while context-overflow
   * recovery can emit false and then compact + continue. Deferring the error to
   * this prompt-settlement boundary prevents both dropped recovery output and a
   * stale error when a later continuation succeeds.
   */
  finalize(): SessionEvent[] {
    if (!this.pendingProviderError) return [];
    const message = this.pendingProviderError;
    this.pendingProviderError = undefined;
    return [
      {
        id: generateEventId(),
        timestamp: generateTimestamp(),
        type: "session.error",
        error: {
          message,
          code: "pi_agent_error",
        },
      } as SessionEvent,
    ];
  }
}

/**
 * Extract the in-progress tool call at `contentIndex` from a streamed `partial`
 * AssistantMessage. During a `toolcall_*` stream the SDK fills
 * `partial.content[contentIndex]` with a `{ type: "toolCall", id, name, ... }`
 * block (id/name present from the start, arguments filling in). Returns its
 * id/name, or undefined if the slot is missing or not a tool call.
 */
function toolCallAt(
  partial: unknown,
  contentIndex: number,
): { id: string; name: string } | undefined {
  const content = (partial as { content?: unknown })?.content;
  if (!Array.isArray(content)) return undefined;
  const block = content[contentIndex] as
    | { type?: string; id?: string; name?: string }
    | undefined;
  if (!block || block.type !== "toolCall") return undefined;
  if (typeof block.id !== "string" || typeof block.name !== "string") {
    return undefined;
  }
  return { id: block.id, name: block.name };
}

/**
 * The SDK's `tool_execution_end.result` is typed `any`. It may be a plain
 * string, an `AgentToolResult` (with a `content` array of text/image blocks),
 * or arbitrary JSON. Flatten it to a single text string for the canonical
 * `agent.tool_result` event.
 */
function normalizeResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const text = content
        .map((block) => {
          if (block && typeof block === "object" && "text" in block) {
            return String((block as { text: unknown }).text ?? "");
          }
          return "";
        })
        .filter(Boolean)
        .join("");
      if (text) return text;
    }
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}
