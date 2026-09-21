import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionEvent } from "@open-managed-agents/adapter-core";
import { identifyMcpInvocation, type McpInvocation } from "./mcp-gateway.js";

export const PI_DISPLAY_TYPES = new Set([
  "agent.message", "agent.thinking", "agent.tool_use", "agent.mcp_tool_use", "agent.tool_result", "agent.mcp_tool_result",
]);

/** Capture alignment synchronously, before an out-of-band compaction commit can
 * overtake the Host's asynchronous stream consumer. Indices are per Adapter run. */
export class PiStreamAlignment {
  private nextIndex = 0;
  private starts: Array<{ types: string[]; toolUseId?: string; index: number }> = [];
  private completed: Array<{ type: string; toolUseId?: string; index: number }> = [];

  observe(event: SessionEvent): void {
    if (event.type === "agent.message_stream_start" || event.type === "agent.thinking_stream_start" || event.type === "agent.tool_use_input_stream_start") {
      this.starts.push({ index: this.nextIndex++, types: event.type === "agent.message_stream_start" ? ["agent.message"]
        : event.type === "agent.thinking_stream_start" ? ["agent.thinking"] : ["agent.tool_use", "agent.mcp_tool_use"],
        ...(event.type === "agent.tool_use_input_stream_start" ? { toolUseId: event.toolUseId } : {}) });
    } else if (PI_DISPLAY_TYPES.has(event.type)) {
      const toolUseId = "toolUseId" in event ? event.toolUseId : undefined;
      let index = -1;
      for (let i = this.starts.length - 1; i >= 0; i--) {
        const start = this.starts[i];
        if (start.types.includes(event.type) && (!start.toolUseId || start.toolUseId === toolUseId)) { index = i; break; }
      }
      if (index < 0) return;
      const [start] = this.starts.splice(index, 1);
      this.completed.push({ type: event.type, toolUseId, index: start.index });
    }
  }

  attach(event: SessionEvent): SessionEvent {
    if (event.type !== "agent.context_entry" || !event.presentation) return event;
    const entry = event.entry as SessionEntry;
    if (entry.type !== "message" || entry.message.role !== "assistant") return event;
    const content = entry.message.content;
    return { ...event, presentation: { version: 1, blocks: event.presentation.blocks.map(display => {
      const block = content[display.index ?? 0];
      const toolUseId = block?.type === "toolCall" ? block.id : undefined;
      const index = this.completed.findIndex(item => item.type === display.type && item.toolUseId === toolUseId);
      if (index < 0) return display;
      const [completed] = this.completed.splice(index, 1);
      return { ...display, streamIndex: completed.index };
    }) } };
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
