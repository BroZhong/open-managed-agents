import { createHash } from "node:crypto";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionEvent } from "@open-managed-agents/adapter-core";
import { eventLogToAgentMessages } from "./event-log-to-messages.js";

/** Rebuild the native tree using durable identities, with a legacy-only fallback. */
export function restorePiSession(history: SessionEvent[], cwd?: string, id?: string): SessionManager {
  const manager = SessionManager.inMemory(cwd, id ? { id } : undefined);
  const native = history.filter(e => e.type === "agent.context_entry");
  const inputs = new Set(history.filter(e => e.type === "agent.context_entry" || e.type === "agent.context_start").map(e => e.inputEventId).filter(Boolean));
  const assistantTurns = new Set<string>();
  const toolResults = new Set<string>();
  const toolNames = new Map<string, string>();
  const unexecutedTools = new Set<string>();
  const instructions = new Set<string>();
  for (const event of native) {
    const entry = event.entry as SessionEntry;
    if (entry.type === "message" && entry.message.role === "assistant") {
      assistantTurns.add(event.turnId);
      for (const block of entry.message.content) {
        if (block.type !== "toolCall") continue;
        toolNames.set(block.id, block.name);
        if (entry.message.stopReason === "aborted" || entry.message.stopReason === "error") unexecutedTools.add(block.id);
      }
    }
    if (entry.type === "message" && entry.message.role === "toolResult") toolResults.add(entry.message.toolCallId);
    if (entry.type === "custom_message" && entry.customType === "subagent.instruction") {
      instructions.add((entry.details as { instructionId: string }).instructionId);
    }
  }
  let legacy: SessionEvent[] = [];
  const flushLegacy = () => {
    if (!legacy.length) return;
    // These are compatibility messages, not evidence of missing native metadata.
    const key = createHash("sha256").update(JSON.stringify(legacy, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)).digest("hex").slice(0, 24);
    eventLogToAgentMessages(legacy).forEach((message, index) => manager.restoreEntry({
      type: "message", id: `legacy_${key}_${index}`, parentId: manager.getLeafId(),
      timestamp: new Date(0).toISOString(), message,
    }));
    legacy = [];
  };
  for (const event of history) {
    if (event.type === "agent.context_entry") {
      flushLegacy();
      if (event.sdk !== "pi@0.83.0") throw new Error("Unsupported Pi context record version");
      manager.restoreEntry(event.entry as SessionEntry);
    } else {
      const data = event as SessionEvent & { turnId?: string; toolUseId?: string; instructionId?: string };
      if (inputs.has(event.id)) continue;
      if (["agent.message", "agent.tool_use", "agent.mcp_tool_use"].includes(event.type) && data.turnId && assistantTurns.has(data.turnId)) continue;
      if (data.toolUseId && (toolResults.has(data.toolUseId) || unexecutedTools.has(data.toolUseId)) && ["agent.tool_result", "agent.mcp_tool_result"].includes(event.type)) continue;
      if (data.instructionId && instructions.has(data.instructionId)) continue;
      if (["user.message", "delegation.input", "subagent.result_claimed", "subagent.instruction", "agent.message", "agent.tool_use", "agent.mcp_tool_use", "agent.tool_result", "agent.mcp_tool_result"].includes(event.type)) {
        legacy.push(event.type === "agent.tool_result" && !event.name && toolNames.has(event.toolUseId)
          ? { ...event, name: toolNames.get(event.toolUseId) } : event);
      }
    }
  }
  flushLegacy();
  return manager;
}
