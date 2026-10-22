import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentContextEntryEvent, SessionEvent } from "@open-managed-agents/adapter-core";
import { isStreamEvent } from "@open-managed-agents/adapter-core";
import { identifyMcpInvocation, type McpInvocation } from "./mcp-gateway.js";

export const PI_DISPLAY_TYPES = new Set([
  "agent.message", "agent.thinking", "agent.tool_use", "agent.mcp_tool_use", "agent.tool_result", "agent.mcp_tool_result",
]);

type Presentation = NonNullable<AgentContextEntryEvent["presentation"]>;

/**
 * Align Complete Events with the stream blocks whose Deltas they replace.
 * Alignment is captured synchronously, so a commit at a native boundary cannot
 * overtake it. Stream indices count this run's starts; a final blockIndex adds
 * the Host's base (ADR-0020).
 */
export class PiStreamAlignment {
  private nextIndex = 0;
  private starts: Array<{ types: string[]; toolUseId?: string; index: number }> = [];
  private completed: Array<{ type: string; toolUseId?: string; index: number }> = [];
  /** Tool argument streams can interleave; their Deltas name their call. */
  private readonly toolStreams = new Map<string, number>();

  constructor(private readonly blockBase = 0) {}

  /**
   * Track one translated event. Returns the final blockIndex of a Delta, or of
   * a display Complete Event that completes a started block.
   */
  observe(event: SessionEvent): number | undefined {
    if (event.type === "agent.message_stream_start" || event.type === "agent.thinking_stream_start" || event.type === "agent.tool_use_input_stream_start") {
      const index = this.nextIndex++;
      this.starts.push({ index, types: event.type === "agent.message_stream_start" ? ["agent.message"]
        : event.type === "agent.thinking_stream_start" ? ["agent.thinking"] : ["agent.tool_use", "agent.mcp_tool_use"],
        ...(event.type === "agent.tool_use_input_stream_start" ? { toolUseId: event.toolUseId } : {}) });
      if (event.type === "agent.tool_use_input_stream_start" && event.toolUseId) this.toolStreams.set(event.toolUseId, index);
      return this.blockBase + index;
    }
    if (isStreamEvent(event)) {
      const tool = "toolUseId" in event ? this.toolStreams.get(event.toolUseId) : undefined;
      // Otherwise the latest started block, as the Router assigned before ADR-0020.
      return Math.max(0, this.blockBase + (tool ?? this.nextIndex - 1));
    }
    if (!PI_DISPLAY_TYPES.has(event.type)) return undefined;
    const toolUseId = "toolUseId" in event ? event.toolUseId : undefined;
    const start = this.claimStart(event.type, toolUseId);
    if (start === undefined) return undefined;
    this.completed.push({ type: event.type, toolUseId, index: start });
    return this.blockBase + start;
  }

  /** Final blockIndex of each display block of a native assistant entry. */
  align<T extends SessionEvent>(event: T): T {
    const blocks = this.blocks(event);
    if (!blocks) return event;
    // A block no translated completion claimed (an interrupted thinking stream,
    // say) takes the latest started block of its kind, matched backwards.
    for (let i = blocks.length - 1; i >= 0; i--) {
      blocks[i].index ??= this.claimStart(blocks[i].display.type, blocks[i].toolUseId);
    }
    return { ...event, presentation: { version: 1, blocks: blocks.map(({ display, index }) =>
      index === undefined ? display : { ...display, blockIndex: this.blockBase + index }) } };
  }

  /** Display blocks of a native assistant entry with the stream index their completion claimed. */
  private blocks(event: SessionEvent): Array<{ display: Presentation["blocks"][number]; toolUseId?: string; index?: number }> | undefined {
    if (event.type !== "agent.context_entry" || !event.presentation) return undefined;
    const entry = event.entry as SessionEntry;
    if (entry.type !== "message" || entry.message.role !== "assistant") return undefined;
    const content = entry.message.content;
    return event.presentation.blocks.map(display => {
      const block = content[display.index ?? 0];
      const toolUseId = block?.type === "toolCall" ? block.id : undefined;
      const index = this.completed.findIndex(item => item.type === display.type && item.toolUseId === toolUseId);
      return { display, toolUseId, index: index < 0 ? undefined : this.completed.splice(index, 1)[0].index };
    });
  }

  /** Take the latest unclaimed start a completion of this type can replace. */
  private claimStart(type: string, toolUseId: string | undefined): number | undefined {
    for (let i = this.starts.length - 1; i >= 0; i--) {
      const start = this.starts[i];
      if (start.types.includes(type) && (!start.toolUseId || start.toolUseId === toolUseId)) return this.starts.splice(i, 1)[0].index;
    }
    return undefined;
  }
}

/** No content copies. Host derives the existing display protocol from these selectors. */
export class PiPresentation {
  private readonly calls = new Map<string, McpInvocation>();
  constructor(private readonly servers: string[]) {}

  describe(entry: SessionEntry) {
    const blocks: Array<{ type: string; index?: number; name?: string; serverName?: string; unexecuted?: "aborted" | "error" }> = [];
    if (entry.type === "message" && entry.message.role === "assistant") {
      entry.message.content.forEach((block, index) => {
        if (block.type === "text" && block.text) blocks.push({ type: "agent.message", index });
        else if (block.type === "thinking" && block.thinking) blocks.push({ type: "agent.thinking", index });
        else if (block.type === "toolCall") {
          const mcp = identifyMcpInvocation(block.name, block.arguments, this.servers);
          if (mcp) this.calls.set(block.id, mcp);
          blocks.push(mcp ? { type: "agent.mcp_tool_use", index, name: mcp.name, serverName: mcp.serverName }
            : { type: "agent.tool_use", index });
          // An interrupted argument stream never executed. Its failure card is
          // derivable from this native assistant; no synthetic result row is needed.
          if (entry.message.role === "assistant" && (entry.message.stopReason === "aborted" || entry.message.stopReason === "error")) {
            blocks.push({ type: mcp ? "agent.mcp_tool_result" : "agent.tool_result", index,
              ...(mcp ? { serverName: mcp.serverName } : {}), unexecuted: entry.message.stopReason });
          }
        }
      });
    } else if (entry.type === "message" && entry.message.role === "toolResult") {
      const mcp = this.calls.get(entry.message.toolCallId);
      blocks.push(mcp ? { type: "agent.mcp_tool_result", serverName: mcp.serverName } : { type: "agent.tool_result" });
    }
    return { version: 1 as const, blocks };
  }
}
