export interface SessionEvent {
  seq: number;
  type: string;
  data: unknown;
  ts: string;
}

export interface UserMessageEvent extends SessionEvent {
  type: "user.message";
  data: { content: Array<{ type: "text"; text: string }> };
}

export interface AgentMessageEvent extends SessionEvent {
  type: "agent.message";
  data: { content: Array<{ type: "text"; text: string }> };
}

export interface AgentMessageStreamStartEvent extends SessionEvent {
  type: "agent.message_stream_start";
  data: Record<string, never>;
}

export interface AgentMessageChunkEvent extends SessionEvent {
  type: "agent.message_chunk";
  data: { text: string };
}

export interface AgentThinkingEvent extends SessionEvent {
  type: "agent.thinking";
  data: { text: string };
}

export interface AgentThinkingStreamStartEvent extends SessionEvent {
  type: "agent.thinking_stream_start";
  data: Record<string, never>;
}

export interface AgentThinkingChunkEvent extends SessionEvent {
  type: "agent.thinking_chunk";
  data: { text: string };
}

export interface AgentToolUseEvent extends SessionEvent {
  type: "agent.tool_use";
  data: { toolUseId: string; name: string; input: unknown };
}

export interface AgentToolResultEvent extends SessionEvent {
  type: "agent.tool_result";
  data: { toolUseId: string; content: unknown; isError?: boolean };
}

export interface SessionStatusRunningEvent extends SessionEvent {
  type: "session.status_running";
  data: Record<string, never>;
}

export interface SessionStatusIdleEvent extends SessionEvent {
  type: "session.status_idle";
  data: Record<string, never>;
}

export interface SessionErrorEvent extends SessionEvent {
  type: "session.error";
  data: { error: { message: string; code?: string } };
}

export interface AgentToolUseInputStreamStartEvent extends SessionEvent {
  type: "agent.tool_use_input_stream_start";
  data: { toolUseId: string; name: string };
}

export interface AgentToolUseInputChunkEvent extends SessionEvent {
  type: "agent.tool_use_input_chunk";
  data: { toolUseId: string; text: string };
}

export interface AgentMcpToolUseEvent extends SessionEvent {
  type: "agent.mcp_tool_use";
  data: { toolUseId: string; name: string; input: unknown; serverName: string };
}

export interface SpanModelRequestEndEvent extends SessionEvent {
  type: "span.model_request_end";
  data: { usage: { inputTokens: number; outputTokens: number } };
}

export type TypedSessionEvent =
  | UserMessageEvent
  | AgentMessageEvent
  | AgentMessageStreamStartEvent
  | AgentMessageChunkEvent
  | AgentThinkingEvent
  | AgentThinkingStreamStartEvent
  | AgentThinkingChunkEvent
  | AgentToolUseEvent
  | AgentToolResultEvent
  | AgentToolUseInputStreamStartEvent
  | AgentToolUseInputChunkEvent
  | AgentMcpToolUseEvent
  | SessionStatusRunningEvent
  | SessionStatusIdleEvent
  | SessionErrorEvent
  | SpanModelRequestEndEvent;
