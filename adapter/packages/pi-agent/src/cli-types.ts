/**
 * Pi CLI JSONL event types.
 * These model the shape of `pi --print --mode json` output.
 */

export interface PiMessageContent {
  type: string;
  text?: string;
  thinking?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
}

export interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { total: number };
}

export interface PiMessage {
  role: string;
  content: PiMessageContent[];
  model?: string;
  provider?: string;
  usage?: PiUsage;
  stopReason?: string;
}

export interface PiAssistantMessageEvent {
  type: string;
  contentIndex?: number;
  delta?: string;
  content?: string;
  toolCall?: {
    id: string;
    name: string;
    args: unknown;
  };
  partial?: PiMessage;
  reason?: string;
  message?: PiMessage;
}

export interface PiSession {
  type: "session";
}

export interface PiAgentStart {
  type: "agent_start";
}

export interface PiTurnStart {
  type: "turn_start";
}

export interface PiMessageStart {
  type: "message_start";
  message?: PiMessage;
}

export interface PiMessageUpdate {
  type: "message_update";
  assistantMessageEvent?: PiAssistantMessageEvent;
}

export interface PiToolExecutionStart {
  type: "tool_execution_start";
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
}

export interface PiToolExecutionEnd {
  type: "tool_execution_end";
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  toolResults?: Array<{ role: string; content: unknown[] }>;
}

export interface PiMessageEnd {
  type: "message_end";
  message?: PiMessage;
}

export interface PiTurnEnd {
  type: "turn_end";
  messages?: PiMessage[];
}

export interface PiAgentEnd {
  type: "agent_end";
}

export type PiCliEvent =
  | PiSession
  | PiAgentStart
  | PiTurnStart
  | PiMessageStart
  | PiMessageUpdate
  | PiToolExecutionStart
  | PiToolExecutionEnd
  | PiMessageEnd
  | PiTurnEnd
  | PiAgentEnd;
