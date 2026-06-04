import type { SessionEvent } from "@open-managed-agents/adapter-core";
import {
  generateEventId,
  generateTimestamp,
} from "@open-managed-agents/adapter-core";
import type { PiCliEvent } from "./cli-types.js";

export class PiEventTranslator {
  private spanStarted = false;
  private currentModel = "";
  private textAccumulator = "";
  private thinkingAccumulator = "";
  private toolUseIds = new Map<string, string>();

  processEvent(event: PiCliEvent): SessionEvent[] {
    const events: SessionEvent[] = [];

    switch (event.type) {
      case "session":
      case "agent_start":
      case "turn_start":
      case "turn_end":
      case "agent_end":
        break;

      case "message_start": {
        if (event.message?.role === "assistant") {
          if (!this.spanStarted) {
            this.spanStarted = true;
            this.currentModel =
              event.message.model || event.message.provider || "unknown";
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
        if (event.assistantMessageEvent) {
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
              this.thinkingAccumulator =
                ame.content ?? this.thinkingAccumulator;
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

            case "toolcall_start":
              events.push({
                id: generateEventId(),
                timestamp: generateTimestamp(),
                type: "agent.tool_use_input_stream_start",
                toolUseId: "",
                name: "",
              } as SessionEvent);
              break;

            case "toolcall_delta":
              if (ame.delta) {
                events.push({
                  id: generateEventId(),
                  timestamp: generateTimestamp(),
                  type: "agent.tool_use_input_chunk",
                  toolUseId: "",
                  delta: ame.delta,
                } as SessionEvent);
              }
              break;

            case "toolcall_end":
              events.push({
                id: generateEventId(),
                timestamp: generateTimestamp(),
                type: "agent.tool_use_input_stream_end",
                toolUseId: "",
              } as SessionEvent);
              if (ame.toolCall) {
                const toolEventId = generateEventId();
                this.toolUseIds.set(ame.toolCall.id, toolEventId);
                events.push({
                  id: toolEventId,
                  timestamp: generateTimestamp(),
                  type: "agent.tool_use",
                  toolUseId: ame.toolCall.id,
                  name: ame.toolCall.name,
                  input:
                    typeof ame.toolCall.args === "object" &&
                    ame.toolCall.args !== null
                      ? (ame.toolCall.args as Record<string, unknown>)
                      : {},
                } as SessionEvent);
              }
              break;
          }
        }
        break;
      }

      case "tool_execution_end": {
        if (event.toolCallId) {
          const parentId =
            this.toolUseIds.get(event.toolCallId) ?? event.toolCallId;
          events.push({
            id: generateEventId(),
            timestamp: generateTimestamp(),
            type: "agent.tool_result",
            toolUseId: parentId,
            content: [
              {
                type: "text",
                text:
                  typeof event.result === "string"
                    ? event.result
                    : JSON.stringify(event.result),
              },
            ],
            isError: event.isError ?? false,
          } as SessionEvent);
        }
        break;
      }

      case "message_end": {
        if (event.message?.role === "assistant" && event.message.usage) {
          if (this.spanStarted) {
            this.spanStarted = false;
            events.push({
              id: generateEventId(),
              timestamp: generateTimestamp(),
              type: "span.model_request_end",
              usage: {
                inputTokens: event.message.usage.input,
                outputTokens: event.message.usage.output,
              },
            } as SessionEvent);
          }
        }
        break;
      }
    }

    return events;
  }
}
