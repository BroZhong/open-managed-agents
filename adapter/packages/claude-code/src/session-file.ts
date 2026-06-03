import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionEvent } from "@open-managed-agents/adapter-core";

// ─── Session file message types ─────────────────────────────────────────────

interface TextContent {
  type: "text";
  text: string;
}

interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

interface ToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

type MessageContent = TextContent | ThinkingContent | ToolUseContent | ToolResultContent;

interface SessionFileMessage {
  role: "user" | "assistant";
  content: MessageContent[];
}

// ─── Event type sets for filtering ──────────────────────────────────────────

const CANONICAL_AGENT_TYPES = new Set([
  "agent.message",
  "agent.thinking",
  "agent.tool_use",
  "agent.tool_result",
  "agent.mcp_tool_use",
  "agent.mcp_tool_result",
]);

// ─── Conversion helpers ─────────────────────────────────────────────────────

function contentBlocksToText(
  blocks: Array<{ type: string; text?: string }>,
): string {
  return blocks
    .filter((b) => b.type === "text" && b.text !== undefined)
    .map((b) => b.text!)
    .join("");
}

function convertEvent(event: SessionEvent): SessionFileMessage | null {
  if (!CANONICAL_AGENT_TYPES.has(event.type)) {
    return null;
  }

  switch (event.type) {
    case "agent.message": {
      return {
        role: "assistant",
        content: event.content.map((block) => {
          if (block.type === "text") {
            return { type: "text" as const, text: block.text };
          }
          // Image blocks are passed as text description
          return { type: "text" as const, text: "[image]" };
        }),
      };
    }

    case "agent.thinking": {
      return {
        role: "assistant",
        content: [{ type: "thinking", thinking: event.text }],
      };
    }

    case "agent.tool_use": {
      return {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: event.toolUseId,
            name: event.name,
            input: event.input,
          },
        ],
      };
    }

    case "agent.tool_result": {
      const result: ToolResultContent = {
        type: "tool_result",
        tool_use_id: event.toolUseId,
        content: contentBlocksToText(event.content),
      };
      if (event.isError) {
        result.is_error = true;
      }
      return {
        role: "user",
        content: [result],
      };
    }

    case "agent.mcp_tool_use": {
      return {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: event.toolUseId,
            name: event.name,
            input: event.input,
          },
        ],
      };
    }

    case "agent.mcp_tool_result": {
      const result: ToolResultContent = {
        type: "tool_result",
        tool_use_id: event.toolUseId,
        content: contentBlocksToText(event.content),
      };
      if (event.isError) {
        result.is_error = true;
      }
      return {
        role: "user",
        content: [result],
      };
    }

    default:
      return null;
  }
}

// ─── Main exports ───────────────────────────────────────────────────────────

/**
 * Reconstructs the conversation message history from a stream of SessionEvents.
 *
 * Only canonical agent events (agent.message, agent.thinking, agent.tool_use,
 * agent.tool_result, agent.mcp_tool_use, agent.mcp_tool_result) are included.
 * Streaming events, lifecycle events, and span events are skipped.
 *
 * This is a pure function — no I/O. Use it to rebuild the message array
 * from events alone (e.g., for resuming a session or rendering a chat UI).
 */
export function eventsToMessages(events: SessionEvent[]): SessionFileMessage[] {
  const messages: SessionFileMessage[] = [];

  for (const event of events) {
    const message = convertEvent(event);
    if (message !== null) {
      messages.push(message);
    }
  }

  return messages;
}

/**
 * Converts SessionEvent[] into a Claude Code SDK session file.
 * Writes the session file as JSON to {workDir}/{sessionId}/session.json.
 *
 * Only canonical agent events (agent.message, agent.thinking, agent.tool_use,
 * agent.tool_result, agent.mcp_tool_use, agent.mcp_tool_result) are included.
 * Streaming events, lifecycle events, and span events are skipped.
 *
 * Note: Compaction support (agent.thread_context_compacted) is a future
 * enhancement. When added, the function will find the latest compaction
 * boundary and only include events after it.
 *
 * @returns The absolute path to the written session file.
 */
export async function eventsToSessionFile(
  events: SessionEvent[],
  sessionId: string,
  workDir: string,
): Promise<string> {
  const messages = eventsToMessages(events);

  const dir = join(workDir, sessionId);
  await mkdir(dir, { recursive: true });

  const filePath = join(dir, "session.json");
  await writeFile(filePath, JSON.stringify(messages, null, 2), "utf-8");

  return filePath;
}
