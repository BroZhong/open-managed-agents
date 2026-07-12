import type { SessionDelta, SessionEvent } from "@/lib/types";
import { outputBlockKey } from "@/lib/output-block";

interface ToolResultData {
  content: unknown;
  isError: boolean;
}

export interface DisplayMessage {
  id: string;
  role:
    | "user"
    | "assistant"
    | "assistant_streaming"
    | "thinking"
    | "tool_use"
    | "error";
  text: string;
  streaming?: boolean;
  name?: string;
  toolUseId?: string;
  input?: unknown;
  serverName?: string;
  result?: ToolResultData;
  seq?: number;
}

export function shouldShowTypingIndicator(
  messages: DisplayMessage[],
  sessionStatus: "idle" | "running",
): boolean {
  if (sessionStatus !== "running") return false;
  const latestUserIndex = messages.findLastIndex((message) => message.role === "user");
  if (latestUserIndex === -1) return false;
  return messages.slice(latestUserIndex + 1).length === 0;
}

export function processEventsToMessages(
  events: SessionEvent[],
  activeDeltas: SessionDelta[] = [],
): {
  messages: DisplayMessage[];
  isStreaming: boolean;
} {
  const messages: DisplayMessage[] = [];

  const toolResultMap = new Map<
    string,
    { content: unknown; isError: boolean; seq: number }
  >();
  const pairedToolResultSeqs = new Set<number>();

  for (const event of events) {
    if (event.type === "agent.tool_result") {
      const data = event.data as {
        toolUseId: string;
        content: unknown;
        isError?: boolean;
      };
      toolResultMap.set(data.toolUseId, {
        content: data.content,
        isError: data.isError ?? false,
        seq: event.seq,
      });
    }
  }

  // Durable Events project first. Incomplete Delta blocks are projected below
  // as independent aligned blocks, so starting block N+1 cannot erase block N.
  const projectionEvents: SessionEvent[] = events;

  for (const event of projectionEvents) {
    const seq = "seq" in event ? event.seq : undefined;
    switch (event.type) {
      case "user.message": {
        const data = event.data as {
          content: Array<{ type: string; text: string }>;
        };
        const text = data.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        messages.push({
          id: `user-${seq}`,
          role: "user",
          text,
          seq,
        });
        break;
      }
      case "agent.message": {
        const data = event.data as {
          content: Array<{ type: string; text: string }>;
          turnId?: string;
          blockIndex?: number;
        };
        const text = data.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        messages.push({
          id: stableBlockId("assistant", data, seq),
          role: "assistant",
          text,
          seq,
        });
        break;
      }
      case "agent.thinking": {
        const data = event.data as {
          text: string;
          turnId?: string;
          blockIndex?: number;
        };
        messages.push({
          id: stableBlockId("thinking", data, seq),
          role: "thinking",
          text: data.text,
          streaming: false,
          seq,
        });
        break;
      }

      case "agent.tool_use": {
        const data = event.data as {
          toolUseId: string;
          name: string;
          input: unknown;
        };
        const pairedResult = toolResultMap.get(data.toolUseId);
        if (pairedResult) {
          pairedToolResultSeqs.add(pairedResult.seq);
        }

        messages.push({
          id: `tool-${data.toolUseId}`,
          role: "tool_use",
          text: "",
          name: data.name,
          toolUseId: data.toolUseId,
          input: data.input,
          result: pairedResult
            ? { content: pairedResult.content, isError: pairedResult.isError }
            : undefined,
          seq,
        });
        break;
      }
      case "agent.mcp_tool_use": {
        const data = event.data as {
          toolUseId: string;
          name: string;
          input: unknown;
          serverName: string;
        };
        const pairedResult = toolResultMap.get(data.toolUseId);
        if (pairedResult) {
          pairedToolResultSeqs.add(pairedResult.seq);
        }

        messages.push({
          id: `tool-${data.toolUseId}`,
          role: "tool_use",
          text: "",
          name: data.name,
          toolUseId: data.toolUseId,
          input: data.input,
          serverName: data.serverName,
          result: pairedResult
            ? { content: pairedResult.content, isError: pairedResult.isError }
            : undefined,
          seq,
        });
        break;
      }

      case "agent.tool_result": {
        if (seq === undefined || !pairedToolResultSeqs.has(seq)) {
          const data = event.data as {
            toolUseId: string;
            content: unknown;
            isError?: boolean;
          };
          messages.push({
            id: `tool-result-${seq}`,
            role: "tool_use",
            text: "",
            name: "Tool Result",
            toolUseId: data.toolUseId,
            input: null,
            result: {
              content: data.content,
              isError: data.isError ?? false,
            },
            seq,
          });
        }
        break;
      }

      case "session.error": {
        const data = event.data as { error: { message: string } };
        messages.push({
          id: `error-${seq}`,
          role: "error",
          text: data.error.message,
          seq,
        });
        break;
      }
    }
  }

  for (const block of groupActiveDeltas(activeDeltas)) {
    const blockId = outputBlockKey(block);
    let kind: "message" | "thinking" | "tool" | undefined;
    let text = "";
    let toolUseId = "";
    let toolName = "";

    for (const delta of block.deltas) {
      const data = delta.data as Record<string, unknown>;
      switch (delta.type) {
        case "agent.message_stream_start":
          kind = "message";
          break;
        case "agent.message_chunk":
          kind = "message";
          text += typeof data.text === "string" ? data.text : "";
          break;
        case "agent.thinking_stream_start":
          kind = "thinking";
          break;
        case "agent.thinking_chunk":
          kind = "thinking";
          text += typeof data.text === "string" ? data.text : "";
          break;
        case "agent.tool_use_input_stream_start":
          kind = "tool";
          toolUseId = typeof data.toolUseId === "string" ? data.toolUseId : "";
          toolName = typeof data.name === "string" ? data.name : "";
          break;
        case "agent.tool_use_input_chunk":
          kind = "tool";
          if (typeof data.toolUseId === "string") toolUseId = data.toolUseId;
          text +=
            typeof data.delta === "string"
              ? data.delta
              : typeof data.text === "string"
                ? data.text
                : "";
          break;
      }
    }

    if (kind === "message" && text) {
      messages.push({
        id: `assistant-${blockId}`,
        role: "assistant_streaming",
        text,
      });
    } else if (kind === "thinking" && text) {
      messages.push({
        id: `thinking-${blockId}`,
        role: "thinking",
        text,
        streaming: true,
      });
    } else if (kind === "tool" && toolUseId) {
      messages.push({
        id: `tool-${toolUseId}`,
        role: "tool_use",
        text: "",
        name: toolName,
        toolUseId,
        input: text,
        streaming: true,
      });
    }
  }

  return {
    messages,
    isStreaming: activeDeltas.length > 0,
  };
}

function stableBlockId(
  prefix: string,
  data: { turnId?: string; blockIndex?: number },
  seq: number | undefined,
): string {
  return typeof data.turnId === "string" && typeof data.blockIndex === "number"
    ? `${prefix}-${outputBlockKey({ turnId: data.turnId, blockIndex: data.blockIndex })}`
    : `${prefix}-${seq}`;
}

interface ActiveDeltaBlock {
  turnId: string;
  blockIndex: number;
  order: number;
  deltas: SessionDelta[];
}

function groupActiveDeltas(activeDeltas: SessionDelta[]): ActiveDeltaBlock[] {
  const groups = new Map<string, ActiveDeltaBlock>();
  for (const delta of activeDeltas) {
    const key = outputBlockKey(delta);
    const existing = groups.get(key);
    if (existing) {
      existing.deltas.push(delta);
    } else {
      groups.set(key, {
        turnId: delta.turnId,
        blockIndex: delta.blockIndex,
        order: groups.size,
        deltas: [delta],
      });
    }
  }
  return [...groups.values()].sort(
    (a, b) => a.blockIndex - b.blockIndex || a.order - b.order,
  );
}
