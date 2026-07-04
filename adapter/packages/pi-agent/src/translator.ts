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
  private textAccumulator = "";
  private thinkingAccumulator = "";
  private toolUseIds = new Map<string, string>();

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
            };
            this.currentModel = msg.model || msg.provider || "unknown";
            events.push({
              id: generateEventId(),
              timestamp: generateTimestamp(),
              type: "span.model_request_start",
              model: this.currentModel,
            } as SessionEvent);
          }
          this.textAccumulator = "";
          this.thinkingAccumulator = "";
        }
        break;
      }

      case "message_update": {
        const ame = event.assistantMessageEvent;
        switch (ame.type) {
          case "text_start":
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
            events.push({
              id: generateEventId(),
              timestamp: generateTimestamp(),
              type: "agent.message",
              content: [{ type: "text", text: this.textAccumulator }],
            } as SessionEvent);
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
              const toolEventId = generateEventId();
              this.toolUseIds.set(toolCall.id, toolEventId);
              events.push({
                id: toolEventId,
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
        const parentId = this.toolUseIds.get(event.toolCallId) ?? event.toolCallId;
        events.push({
          id: generateEventId(),
          timestamp: generateTimestamp(),
          type: "agent.tool_result",
          toolUseId: parentId,
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
          const usage = (event.message as { usage?: { input: number; output: number } })
            .usage;
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
