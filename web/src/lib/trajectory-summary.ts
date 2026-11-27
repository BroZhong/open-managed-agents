import type { SessionEvent } from "@/lib/types";

export interface ToolCallCount {
  id: string;
  name: string;
  count: number;
}

export interface TrajectorySummary {
  totalActions: number;
  toolCalls: number;
  thinking: number;
  output: number;
  tools: ToolCallCount[];
}

/** Count saved display blocks, never their streaming chunks or native copies. */
export function summarizeTrajectory(events: SessionEvent[]): TrajectorySummary {
  const seen = new Set<number>();
  const tools = new Map<string, ToolCallCount>();
  let toolCalls = 0;
  let thinking = 0;
  let output = 0;

  for (const event of events) {
    if (seen.has(event.seq)) continue;
    seen.add(event.seq);

    switch (event.type) {
      case "agent.thinking":
        thinking++;
        break;
      case "agent.message":
        output++;
        break;
      case "agent.tool_use":
      case "agent.mcp_tool_use": {
        const data = event.data && typeof event.data === "object"
          ? event.data as Record<string, unknown> : {};
        const name = typeof data.name === "string" && data.name.trim() ? data.name : "Unknown tool";
        const isMcp = event.type === "agent.mcp_tool_use";
        const server = isMcp && typeof data.serverName === "string" ? data.serverName : "";
        const id = JSON.stringify([event.type, server, name]);
        const tool = tools.get(id) ?? { id, name: isMcp ? `MCP · ${server ? `${server} / ` : ""}${name}` : name, count: 0 };
        tool.count++;
        tools.set(id, tool);
        toolCalls++;
        break;
      }
    }
  }

  return {
    totalActions: toolCalls + thinking + output,
    toolCalls,
    thinking,
    output,
    tools: [...tools.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
  };
}
