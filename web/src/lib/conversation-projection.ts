import type { SessionDelta, SessionEvent } from "@/lib/types";

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
  seq: number;
}

export function processEventsToMessages(
  events: SessionEvent[],
  activeDeltas: SessionDelta[] = [],
): {
  messages: DisplayMessage[];
  isStreaming: boolean;
} {
  const messages: DisplayMessage[] = [];
  let currentStream = "";
  let streaming = false;

  let thinkingStream = "";
  let thinkingStreaming = false;

  let toolInputStream = "";
  let toolInputStreaming = false;
  let toolInputStreamId = "";
  let toolInputStreamName = "";

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

  const projectionEvents: Array<SessionEvent | SessionDelta> = [
    ...events,
    ...activeDeltas,
  ];

  for (const event of projectionEvents) {
    const seq = "seq" in event ? event.seq : -1;
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
        };
        const text = data.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        messages.push({
          id: `assistant-${seq}`,
          role: "assistant",
          text,
          seq,
        });
        streaming = false;
        currentStream = "";
        break;
      }
      case "agent.message_stream_start":
        streaming = true;
        currentStream = "";
        break;
      case "agent.message_chunk": {
        const data = event.data as { text: string };
        currentStream += data.text;
        break;
      }

      case "agent.thinking_stream_start":
        thinkingStreaming = true;
        thinkingStream = "";
        break;
      case "agent.thinking_chunk": {
        const data = event.data as { text: string };
        thinkingStream += data.text;
        break;
      }
      case "agent.thinking": {
        const data = event.data as { text: string };
        thinkingStreaming = false;
        thinkingStream = "";
        messages.push({
          id: `thinking-${seq}`,
          role: "thinking",
          text: data.text,
          streaming: false,
          seq,
        });
        break;
      }

      case "agent.tool_use_input_stream_start": {
        const data = event.data as { toolUseId: string; name: string };
        toolInputStreaming = true;
        toolInputStream = "";
        toolInputStreamId = data.toolUseId;
        toolInputStreamName = data.name;
        break;
      }
      case "agent.tool_use_input_chunk": {
        const data = event.data as { toolUseId: string; delta?: string; text?: string };
        toolInputStream += data.delta ?? data.text ?? "";
        break;
      }

      case "agent.tool_use": {
        const data = event.data as {
          toolUseId: string;
          name: string;
          input: unknown;
        };
        toolInputStreaming = false;
        toolInputStream = "";
        toolInputStreamId = "";
        toolInputStreamName = "";

        const pairedResult = toolResultMap.get(data.toolUseId);
        if (pairedResult) {
          pairedToolResultSeqs.add(pairedResult.seq);
        }

        messages.push({
          id: `tool-${seq}`,
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
        toolInputStreaming = false;
        toolInputStream = "";
        toolInputStreamId = "";
        toolInputStreamName = "";

        const pairedResult = toolResultMap.get(data.toolUseId);
        if (pairedResult) {
          pairedToolResultSeqs.add(pairedResult.seq);
        }

        messages.push({
          id: `tool-${seq}`,
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
        if (!pairedToolResultSeqs.has(seq)) {
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

  if (thinkingStreaming && thinkingStream) {
    messages.push({
      id: "thinking-streaming",
      role: "thinking",
      text: thinkingStream,
      streaming: true,
      seq: -1,
    });
  }

  if (toolInputStreaming && toolInputStreamId) {
    messages.push({
      id: "tool-input-streaming",
      role: "tool_use",
      text: "",
      name: toolInputStreamName,
      toolUseId: toolInputStreamId,
      input: toolInputStream,
      streaming: true,
      seq: -1,
    });
  }

  if (streaming && currentStream) {
    messages.push({
      id: "streaming-current",
      role: "assistant_streaming",
      text: currentStream,
      seq: -1,
    });
  }

  return {
    messages,
    isStreaming: streaming || thinkingStreaming || toolInputStreaming,
  };
}
