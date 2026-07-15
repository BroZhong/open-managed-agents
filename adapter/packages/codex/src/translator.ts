import type { SessionEvent } from "@open-managed-agents/adapter-core";
import {
  generateEventId,
  generateTimestamp,
} from "@open-managed-agents/adapter-core";
import type { CodexCliEvent } from "./cli-types.js";

export class CodexEventTranslator {
  private spanStarted = false;
  private toolUseIds = new Map<string, string>();

  finalize(): SessionEvent[] {
    if (!this.spanStarted) return [];
    this.spanStarted = false;
    return [
      {
        id: generateEventId(),
        timestamp: generateTimestamp(),
        type: "span.model_request_end",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
    ];
  }

  processEvent(event: CodexCliEvent): SessionEvent[] {
    const events: SessionEvent[] = [];

    switch (event.type) {
      case "turn.started": {
        if (!this.spanStarted) {
          this.spanStarted = true;
          events.push({
            id: generateEventId(),
            timestamp: generateTimestamp(),
            type: "span.model_request_start",
            model: "codex",
          });
        }
        break;
      }

      case "item.started": {
        if (event.item.type === "command_execution" && event.item.command) {
          const toolUseId = generateEventId();
          this.toolUseIds.set(event.item.id, toolUseId);
          events.push({
            id: toolUseId,
            timestamp: generateTimestamp(),
            type: "agent.tool_use",
            toolUseId: event.item.id,
            name: "shell",
            input: { command: event.item.command },
          });
        } else if (event.item.type === "tool_call" && event.item.name) {
          const toolUseId = generateEventId();
          this.toolUseIds.set(event.item.id, toolUseId);
          const isMcp = event.item.name.startsWith("mcp__");
          if (isMcp) {
            const parts = event.item.name.split("__");
            events.push({
              id: toolUseId,
              timestamp: generateTimestamp(),
              type: "agent.mcp_tool_use",
              toolUseId: event.item.id,
              serverName: parts[1] ?? "",
              name: parts.slice(2).join("__"),
              input: event.item.arguments
                ? JSON.parse(event.item.arguments)
                : {},
            });
          } else {
            events.push({
              id: toolUseId,
              timestamp: generateTimestamp(),
              type: "agent.tool_use",
              toolUseId: event.item.id,
              name: event.item.name,
              input: event.item.arguments
                ? JSON.parse(event.item.arguments)
                : {},
            });
          }
        }
        break;
      }

      case "item.completed": {
        if (event.item.type === "command_execution") {
          events.push({
            id: generateEventId(),
            timestamp: generateTimestamp(),
            type: "agent.tool_result",
            toolUseId: event.item.id,
            content: [{ type: "text", text: event.item.aggregated_output ?? "" }],
            isError:
              event.item.exit_code !== 0 && event.item.exit_code !== null,
          });
        } else if (event.item.type === "tool_call") {
          const isMcp = event.item.name?.startsWith("mcp__");
          if (isMcp) {
            const parts = (event.item.name ?? "").split("__");
            events.push({
              id: generateEventId(),
              timestamp: generateTimestamp(),
              type: "agent.mcp_tool_result",
              toolUseId: event.item.id,
              serverName: parts[1] ?? "",
              content: [{ type: "text", text: event.item.output ?? "" }],
            });
          } else {
            events.push({
              id: generateEventId(),
              timestamp: generateTimestamp(),
              type: "agent.tool_result",
              toolUseId: event.item.id,
              content: [{ type: "text", text: event.item.output ?? "" }],
            });
          }
        } else if (event.item.type === "agent_message" && event.item.text) {
          events.push({
            id: generateEventId(),
            timestamp: generateTimestamp(),
            type: "agent.message",
            content: [{ type: "text", text: event.item.text }],
          });
        }
        break;
      }

      case "turn.completed": {
        if (this.spanStarted) {
          this.spanStarted = false;
          events.push({
            id: generateEventId(),
            timestamp: generateTimestamp(),
            type: "span.model_request_end",
            usage: {
              inputTokens: event.usage?.input_tokens ?? 0,
              outputTokens: event.usage?.output_tokens ?? 0,
              cacheReadTokens: event.usage?.cached_input_tokens ?? 0,
              cacheWriteTokens: 0,
            },
          });
        }
        break;
      }

      case "turn.failed": {
        if (this.spanStarted) {
          this.spanStarted = false;
          events.push({
            id: generateEventId(),
            timestamp: generateTimestamp(),
            type: "span.model_request_end",
            usage: {
              inputTokens: event.usage?.input_tokens ?? 0,
              outputTokens: event.usage?.output_tokens ?? 0,
              cacheReadTokens: event.usage?.cached_input_tokens ?? 0,
              cacheWriteTokens: 0,
            },
          });
        }
        break;
      }

      case "error": {
        if (this.spanStarted) {
          this.spanStarted = false;
          events.push({
            id: generateEventId(),
            timestamp: generateTimestamp(),
            type: "span.model_request_end",
            usage: {
              inputTokens: event.usage?.input_tokens ?? 0,
              outputTokens: event.usage?.output_tokens ?? 0,
              cacheReadTokens: event.usage?.cached_input_tokens ?? 0,
              cacheWriteTokens: 0,
            },
          });
        }
        break;
      }
    }

    return events;
  }
}
