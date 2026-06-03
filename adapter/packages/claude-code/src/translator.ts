import {
  generateEventId,
  generateTimestamp,
  type SessionEvent,
} from "@open-managed-agents/adapter-core";
import type { SdkMessage, SdkContentBlock } from "./sdk-types.js";

/**
 * State for an active content block being streamed.
 */
interface ActiveBlock {
  index: number;
  type: "text" | "thinking" | "tool_use";
  accumulator: string;
  toolUseId?: string;
  toolName?: string;
}

/**
 * Translates Claude Code SDK streaming messages into SessionEvent sequences.
 *
 * Pure class — no network, no filesystem, no SDK dependency.
 * Feed it SDK messages and collect emitted SessionEvents.
 */
export class SdkEventTranslator {
  private firstTokenEmitted = false;
  private activeBlocks: Map<number, ActiveBlock> = new Map();
  private currentMessageId: string | null = null;
  private currentModel: string | null = null;

  /**
   * Track which tool_use IDs are MCP tools so we can emit the correct
   * result type when a tool_result message arrives.
   */
  private mcpToolMap: Map<string, { serverName: string; name: string }> = new Map();

  constructor(private turnId: string) {}

  /**
   * Process a single SDK message, return emitted events.
   */
  processMessage(message: SdkMessage): SessionEvent[] {
    switch (message.type) {
      case "message_start":
        return this.handleMessageStart(message.message);
      case "content_block_start":
        return this.handleContentBlockStart(message.index, message.content_block);
      case "content_block_delta":
        return this.handleContentBlockDelta(message.index, message.delta);
      case "content_block_stop":
        return this.handleContentBlockStop(message.index);
      case "message_delta":
        return this.handleMessageDelta(message.delta, message.usage);
      case "message_stop":
        return [];
      case "tool_result":
        return this.handleToolResult(
          message.tool_use_id,
          message.content,
          message.is_error
        );
      default:
        return [];
    }
  }

  /**
   * Signal end of SDK stream, return any final events.
   */
  finalize(): SessionEvent[] {
    return [];
  }

  // ─── Private handlers ───────────────────────────────────────────────────────

  private handleMessageStart(msg: { id: string; model: string }): SessionEvent[] {
    this.currentMessageId = msg.id;
    this.currentModel = msg.model;
    this.firstTokenEmitted = false;

    return [
      {
        id: generateEventId(),
        timestamp: generateTimestamp(),
        type: "span.model_request_start",
        model: msg.model,
      },
    ];
  }

  private handleContentBlockStart(
    index: number,
    block: SdkContentBlock
  ): SessionEvent[] {
    const activeBlock: ActiveBlock = {
      index,
      type: block.type,
      accumulator: "",
      toolUseId: block.type === "tool_use" ? block.id : undefined,
      toolName: block.type === "tool_use" ? block.name : undefined,
    };
    this.activeBlocks.set(index, activeBlock);

    const events: SessionEvent[] = [];

    switch (block.type) {
      case "text":
        events.push({
          id: generateEventId(),
          timestamp: generateTimestamp(),
          type: "agent.message_stream_start",
        });
        break;
      case "thinking":
        events.push({
          id: generateEventId(),
          timestamp: generateTimestamp(),
          type: "agent.thinking_stream_start",
        });
        break;
      case "tool_use":
        events.push({
          id: generateEventId(),
          timestamp: generateTimestamp(),
          type: "agent.tool_use_input_stream_start",
          toolUseId: block.id!,
          name: block.name!,
        });
        break;
    }

    return events;
  }

  private handleContentBlockDelta(
    index: number,
    delta: { type: string; text?: string; thinking?: string; partial_json?: string }
  ): SessionEvent[] {
    const block = this.activeBlocks.get(index);
    if (!block) return [];

    const events: SessionEvent[] = [];

    // Emit first token event once per span
    if (!this.firstTokenEmitted) {
      this.firstTokenEmitted = true;
      events.push({
        id: generateEventId(),
        timestamp: generateTimestamp(),
        type: "span.model_first_token",
      });
    }

    switch (block.type) {
      case "text": {
        const text = delta.text ?? "";
        block.accumulator += text;
        events.push({
          id: generateEventId(),
          timestamp: generateTimestamp(),
          type: "agent.message_chunk",
          text,
        });
        break;
      }
      case "thinking": {
        const text = delta.thinking ?? "";
        block.accumulator += text;
        events.push({
          id: generateEventId(),
          timestamp: generateTimestamp(),
          type: "agent.thinking_chunk",
          text,
        });
        break;
      }
      case "tool_use": {
        const json = delta.partial_json ?? "";
        block.accumulator += json;
        events.push({
          id: generateEventId(),
          timestamp: generateTimestamp(),
          type: "agent.tool_use_input_chunk",
          toolUseId: block.toolUseId!,
          delta: json,
        });
        break;
      }
    }

    return events;
  }

  private handleContentBlockStop(index: number): SessionEvent[] {
    const block = this.activeBlocks.get(index);
    if (!block) return [];

    this.activeBlocks.delete(index);
    const events: SessionEvent[] = [];

    switch (block.type) {
      case "text": {
        events.push({
          id: generateEventId(),
          timestamp: generateTimestamp(),
          type: "agent.message_stream_end",
        });
        events.push({
          id: generateEventId(),
          timestamp: generateTimestamp(),
          type: "agent.message",
          content: [{ type: "text", text: block.accumulator }],
        });
        break;
      }
      case "thinking": {
        events.push({
          id: generateEventId(),
          timestamp: generateTimestamp(),
          type: "agent.thinking_stream_end",
        });
        events.push({
          id: generateEventId(),
          timestamp: generateTimestamp(),
          type: "agent.thinking",
          text: block.accumulator,
        });
        break;
      }
      case "tool_use": {
        const toolUseId = block.toolUseId!;
        const toolName = block.toolName!;
        const isMcp = toolName.startsWith("mcp__");
        const inputJson = block.accumulator
          ? JSON.parse(block.accumulator)
          : {};

        events.push({
          id: generateEventId(),
          timestamp: generateTimestamp(),
          type: "agent.tool_use_input_stream_end",
          toolUseId,
        });

        if (isMcp) {
          const serverName = this.extractMcpServerName(toolName);
          this.mcpToolMap.set(toolUseId, { serverName, name: toolName });
          events.push({
            id: generateEventId(),
            timestamp: generateTimestamp(),
            type: "agent.mcp_tool_use",
            toolUseId,
            serverName,
            name: toolName,
            input: inputJson,
          });
        } else {
          events.push({
            id: generateEventId(),
            timestamp: generateTimestamp(),
            type: "agent.tool_use",
            toolUseId,
            name: toolName,
            input: inputJson,
          });
        }
        break;
      }
    }

    return events;
  }

  private handleMessageDelta(
    delta: { stop_reason: string },
    usage: { output_tokens: number }
  ): SessionEvent[] {
    return [
      {
        id: generateEventId(),
        timestamp: generateTimestamp(),
        type: "span.model_request_end",
        usage: {
          inputTokens: 0,
          outputTokens: usage.output_tokens,
        },
      },
    ];
  }

  private handleToolResult(
    toolUseId: string,
    content: string,
    isError?: boolean
  ): SessionEvent[] {
    const mcpInfo = this.mcpToolMap.get(toolUseId);

    if (mcpInfo) {
      return [
        {
          id: generateEventId(),
          timestamp: generateTimestamp(),
          type: "agent.mcp_tool_result",
          toolUseId,
          serverName: mcpInfo.serverName,
          content: [{ type: "text", text: content }],
          isError: isError ?? false,
        },
      ];
    }

    return [
      {
        id: generateEventId(),
        timestamp: generateTimestamp(),
        type: "agent.tool_result",
        toolUseId,
        content: [{ type: "text", text: content }],
        isError: isError ?? false,
      },
    ];
  }

  /**
   * Extract server name from MCP tool name.
   * Format: mcp__<serverName>__<toolName>
   */
  private extractMcpServerName(toolName: string): string {
    const parts = toolName.split("__");
    return parts.length >= 2 ? parts[1] : "";
  }
}
