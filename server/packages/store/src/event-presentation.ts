import type { PaginatedResult, StoredEvent } from "./types.js";

/** Metadata only: every displayed block reads its content from the native entry. */
export interface ContextPresentationBlock {
  type: "agent.message" | "agent.thinking" | "agent.tool_use" | "agent.mcp_tool_use" | "agent.tool_result" | "agent.mcp_tool_result";
  index?: number;
  blockIndex?: number;
  serverName?: string;
  name?: string;
  unexecuted?: "aborted" | "error";
}

type RecordValue = Record<string, any>;
export function contextPresentation(type: string, data: unknown): ContextPresentationBlock[] {
  const value = data as RecordValue | null;
  return type === "agent.context_entry" && value?.presentation?.version === 1 && Array.isArray(value.presentation.blocks)
    ? value.presentation.blocks : [];
}

/** Reserve display cursors atomically, while persisting only the native row. */
export function eventSequenceWidth(type: string, data: unknown): number {
  return contextPresentation(type, data).length + 1;
}

function content(blocks: RecordValue[] = []): unknown[] {
  return blocks.flatMap<unknown>(block => block.type === "image"
    ? [{ type: "image", source: { type: "base64", mediaType: block.mimeType, data: block.data } }]
    : block.type === "text" ? [{ type: "text", text: block.text }] : []);
}

function gatewayArguments(value: unknown): RecordValue {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

/** Also works on lightweight native tool-result shells, without fetching OSS. */
export function presentContextData(type: string, data: unknown): Array<{ type: string; data: RecordValue }> {
  const blocks = contextPresentation(type, data);
  const value = data as RecordValue;
  const message = value?.entry?.message;
  return blocks.map((display, index) => {
    const block = message?.content?.[display.index ?? 0];
    const out: RecordValue = {
      id: `${value.id}:display:${index}`, timestamp: value.timestamp,
      type: display.type, sourceEntryId: value.entry.id,
    };
    for (const key of ["turnId", "callerSessionId", "callerTurnId", "callerToolUseId", "executionId"]) {
      if (value[key] !== undefined) out[key] = value[key];
    }
    if (display.blockIndex !== undefined) out.blockIndex = display.blockIndex;
    if (display.serverName !== undefined) out.serverName = display.serverName;
    if (display.type === "agent.tool_result" || display.type === "agent.mcp_tool_result") {
      if (display.unexecuted) {
        Object.assign(out, { toolUseId: block.id, isError: true,
          content: [{ type: "text", text: `Tool was not executed: argument stream ${display.unexecuted === "aborted" ? "interrupted" : "failed"}.` }] });
      } else {
        Object.assign(out, { toolUseId: message.toolCallId, isError: message.isError ?? false });
        if (value.payloadRef) out.payloadRef = value.payloadRef;
        else out.content = content(message.content);
      }
    } else {
      Object.assign(out, { provider: message.provider, api: message.api, model: message.model, stopReason: message.stopReason });
      if (display.type === "agent.message") out.content = [{ type: "text", text: block.text }];
      else if (display.type === "agent.thinking") out.text = block.thinking;
      else Object.assign(out, {
        toolUseId: block.id, name: display.name ?? block.name,
        input: display.type === "agent.mcp_tool_use" ? gatewayArguments(block.arguments?.args) : block.arguments,
        ...((message.stopReason === "aborted" || message.stopReason === "error") ? { inputIncomplete: true } : {}),
      });
    }
    return { type: display.type, data: out };
  });
}

/** Native rows own the end of their reserved range; old rows retain their cursors. */
export function presentEvent<T extends { type: string; seq?: number; data: unknown }>(event: T): T[] {
  const projected = presentContextData(event.type, event.data);
  return [...projected.map((display, index) => ({ ...event, ...display,
    ...(event.seq === undefined ? {} : { seq: event.seq - projected.length + index }),
  })), event];
}

export function presentEventPage(page: PaginatedResult<StoredEvent>, afterSeq = 0, limit = 50): PaginatedResult<StoredEvent> {
  const events = page.data.flatMap(event => presentEvent(event)).filter(event => event.seq > afterSeq);
  return { data: events.slice(0, limit), hasMore: page.hasMore || events.length > limit };
}
