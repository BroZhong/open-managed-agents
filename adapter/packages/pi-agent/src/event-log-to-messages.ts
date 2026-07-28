import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { ContentBlock, SessionEvent } from "@open-managed-agents/adapter-core";

/**
 * Rebuild a structured Pi conversation history (`Message[]`) from the canonical
 * event log (ADR-0003 §1).
 *
 * The event log is the single source of truth for a session. Each turn the Host
 * replays this back into Pi as structured messages — text, tool calls, and tool
 * results — so prior tool activity survives into the model's context and the Pi
 * provider layer (tool-call id normalization, synthetic results, cross-provider
 * transforms, compaction) is actually used, instead of a flat text blob.
 *
 * Mapping:
 *  - `user.message`      → `{ role: "user", content }`
 *  - `agent.message` + the `agent.tool_use` blocks emitted in the same
 *    assistant turn → one `{ role: "assistant", content: [text…, toolCall…],
 *    provider, api, model }`. Tool-use blocks are aggregated INTO the turn's
 *    assistant message (Pi assistant messages interleave text/toolCall in one
 *    `content` array), never emitted standalone.
 *  - `agent.tool_result` → `{ role: "toolResult", toolCallId, content, isError }`
 *
 * The `toolUseId` stored on `agent.tool_use` / `agent.tool_result` is the
 * `toolCall.id` ↔ `toolResult.toolCallId` pairing key. Each assistant message
 * carries the origin `provider`/`api`/`model`, so the provider layer's
 * `isSameModel` check keeps tool ids byte-stable for same-model turns and
 * normalizes only across a model switch. It also carries the recorded
 * `stopReason`, which is how an Interrupted Turn's half-written output stays in
 * the event log and the frontend yet is dropped from the model's context — Pi's
 * own conversion layer skips assistant messages marked `aborted`/`error`.
 *
 * History events reach the adapter shaped as `{ type, ...data }` (the Host
 * spreads the stored event body onto the type). This translator reads defensively
 * from that shape and ignores lifecycle / span / streaming events.
 */
export function eventLogToAgentMessages(history: SessionEvent[]): Message[] {
  const messages: Message[] = [];

  // The assistant turn currently being aggregated (text + tool calls from a
  // single `agent.message`/`agent.tool_use` run). Flushed when a non-assistant
  // event (user message or tool result) arrives, or at the end.
  let pendingAssistant:
    | {
        content: (TextContent | ToolCall)[];
        provider?: string;
        api?: string;
        model?: string;
        stopReason?: string;
      }
    | undefined;

  // Tool calls belonging to an assistant message Pi will discard. Pi drops such
  // an assistant whole — its `toolCall` blocks with it — so a `toolResult` for
  // one of them would reach the provider with no request in front of it, which
  // the provider APIs reject. Their results are therefore dropped too, which is
  // also the honest reading: a result nobody asked for is not history.
  const discardedToolCallIds = new Set<string>();

  const flushAssistant = (): void => {
    if (!pendingAssistant || pendingAssistant.content.length === 0) {
      pendingAssistant = undefined;
      return;
    }
    if (isDiscardedByPi(pendingAssistant.stopReason)) {
      for (const block of pendingAssistant.content) {
        if (block.type === "toolCall") discardedToolCallIds.add(block.id);
      }
    }
    messages.push(makeAssistant(pendingAssistant));
    pendingAssistant = undefined;
  };

  for (const event of history) {
    const record = event as unknown as EventRecord;

    switch (record.type) {
      case "user.message": {
        flushAssistant();
        const content = normalizeUserContent(pickContent(record));
        messages.push({ role: "user", content, timestamp: 0 });
        break;
      }

      case "agent.message": {
        const text = textFrom(pickContent(record));
        if (!pendingAssistant) {
          pendingAssistant = {
            content: [],
            provider: record.provider,
            api: record.api,
            model: record.model,
            stopReason: record.stopReason,
          };
        } else {
          // Model metadata may only be present on the message event; keep the
          // first non-empty values seen for the turn.
          pendingAssistant.provider ??= record.provider;
          pendingAssistant.api ??= record.api;
          pendingAssistant.model ??= record.model;
          pendingAssistant.stopReason ??= record.stopReason;
        }
        if (text) {
          pendingAssistant.content.push({ type: "text", text });
        }
        break;
      }

      case "agent.tool_use":
      case "agent.mcp_tool_use": {
        if (!pendingAssistant) pendingAssistant = { content: [] };
        pendingAssistant.content.push({
          type: "toolCall",
          id: record.toolUseId ?? "",
          name: record.name ?? "",
          arguments:
            record.input && typeof record.input === "object"
              ? record.input
              : {},
        });
        break;
      }

      case "agent.tool_result":
      case "agent.mcp_tool_result": {
        // A tool result closes the assistant turn that requested it.
        flushAssistant();
        if (record.toolUseId && discardedToolCallIds.has(record.toolUseId)) break;
        const result: ToolResultMessage = {
          role: "toolResult",
          toolCallId: record.toolUseId ?? "",
          toolName: record.name ?? "",
          content: normalizeResultContent(pickContent(record)),
          isError: record.isError ?? false,
          timestamp: 0,
        };
        messages.push(result);
        break;
      }

      // agent.thinking, span.*, session.*, and streaming events do not
      // participate in the rebuilt LLM history.
      default:
        break;
    }
  }

  flushAssistant();
  return messages;
}

interface EventRecord {
  type: string;
  content?: ContentBlock[];
  data?: { content?: ContentBlock[] };
  toolUseId?: string;
  name?: string;
  input?: Record<string, unknown>;
  isError?: boolean;
  provider?: string;
  api?: string;
  model?: string;
  stopReason?: string;
}

/** Pull the content blocks from either the flat or the `{ data }` shape. */
function pickContent(record: EventRecord): ContentBlock[] {
  return record.content ?? record.data?.content ?? [];
}

function textFrom(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Map canonical content blocks to Pi user-message content (text + images). */
function normalizeUserContent(
  blocks: ContentBlock[],
): (TextContent | ImageContent)[] {
  const out: (TextContent | ImageContent)[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      out.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      out.push({
        type: "image",
        data: block.source.data,
        mimeType: block.source.mediaType,
      });
    }
  }
  // A message with no renderable content still needs a content array.
  if (out.length === 0) out.push({ type: "text", text: "" });
  return out;
}

/** Map canonical content blocks to Pi tool-result content (text + images). */
function normalizeResultContent(
  blocks: ContentBlock[],
): (TextContent | ImageContent)[] {
  return normalizeUserContent(blocks);
}

function makeAssistant(pending: {
  content: (TextContent | ToolCall)[];
  provider?: string;
  api?: string;
  model?: string;
  stopReason?: string;
}): AssistantMessage {
  return {
    role: "assistant",
    content: pending.content,
    api: pending.api ?? "",
    provider: pending.provider ?? "",
    model: pending.model ?? "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    // Carry the recorded reason through instead of asserting "stop" (issue
    // #111). Pi's own message-conversion layer drops assistant messages whose
    // stopReason is "aborted"/"error" so the model retries from the last valid
    // state; hardcoding "stop" here made that branch unreachable and replayed
    // Interrupted output as if it had finished. Events without the field are
    // legacy or normally-completed, so they still default to "stop".
    stopReason: isStopReason(pending.stopReason) ? pending.stopReason : "stop",
    timestamp: 0,
  };
}

const STOP_REASONS: ReadonlySet<string> = new Set([
  "stop",
  "length",
  "toolUse",
  "error",
  "aborted",
]);

/** Guard the free-text event field down to Pi's `StopReason` union. */
function isStopReason(value: unknown): value is AssistantMessage["stopReason"] {
  return typeof value === "string" && STOP_REASONS.has(value);
}

/**
 * Whether Pi's message-conversion layer will drop an assistant with this stop
 * reason ("The model should retry from the last valid state"). Mirrors the check
 * in `pi-ai`'s `transformMessages`; we only need to know which tool calls go
 * down with it.
 */
function isDiscardedByPi(stopReason: string | undefined): boolean {
  return stopReason === "aborted" || stopReason === "error";
}
