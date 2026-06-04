// ─── Content blocks ──────────────────────────────────────────────────────────

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  source: {
    type: "base64";
    mediaType: string;
    data: string;
  };
}

export type ContentBlock = TextBlock | ImageBlock;

// ─── Tool / MCP config ───────────────────────────────────────────────────────

export interface ToolConfig {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerConfig {
  name: string;
  url: string;
  transport?: "sse" | "streamable-http";
  headers?: Record<string, string>;
}

// ─── User message ────────────────────────────────────────────────────────────

export interface UserMessage {
  role: "user";
  content: ContentBlock[];
}

// ─── Adapter input ───────────────────────────────────────────────────────────

export interface AdapterInput {
  sessionId: string;
  turnId: string;
  message: UserMessage;
  agent: {
    model: string;
    system: string;
    tools?: ToolConfig[];
    mcpServers?: McpServerConfig[];
    skills?: string[];
  };
  history: SessionEvent[];
  constraints?: {
    timeoutSeconds?: number;
    sandbox?: "none" | "read-only" | "workspace-write" | "full-access";
  };
}

// ─── Base event ──────────────────────────────────────────────────────────────

interface BaseEvent {
  id: string;
  timestamp: string;
}

// ─── Lifecycle events ────────────────────────────────────────────────────────

export interface SessionStatusRunningEvent extends BaseEvent {
  type: "session.status_running";
}

export interface SessionStatusIdleEvent extends BaseEvent {
  type: "session.status_idle";
}

export interface SessionErrorEvent extends BaseEvent {
  type: "session.error";
  error: {
    message: string;
    code: string;
  };
}

export type LifecycleEvent =
  | SessionStatusRunningEvent
  | SessionStatusIdleEvent
  | SessionErrorEvent;

// ─── Span events ─────────────────────────────────────────────────────────────

export interface SpanModelRequestStartEvent extends BaseEvent {
  type: "span.model_request_start";
  model: string;
}

export interface SpanModelFirstTokenEvent extends BaseEvent {
  type: "span.model_first_token";
}

export interface SpanModelRequestEndEvent extends BaseEvent {
  type: "span.model_request_end";
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export type SpanEvent =
  | SpanModelRequestStartEvent
  | SpanModelFirstTokenEvent
  | SpanModelRequestEndEvent;

// ─── Canonical agent events ──────────────────────────────────────────────────

export interface AgentMessageEvent extends BaseEvent {
  type: "agent.message";
  content: ContentBlock[];
}

export interface AgentThinkingEvent extends BaseEvent {
  type: "agent.thinking";
  text: string;
}

export interface AgentToolUseEvent extends BaseEvent {
  type: "agent.tool_use";
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentToolResultEvent extends BaseEvent {
  type: "agent.tool_result";
  toolUseId: string;
  content: ContentBlock[];
  isError?: boolean;
}

export interface AgentMcpToolUseEvent extends BaseEvent {
  type: "agent.mcp_tool_use";
  toolUseId: string;
  serverName: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentMcpToolResultEvent extends BaseEvent {
  type: "agent.mcp_tool_result";
  toolUseId: string;
  serverName: string;
  content: ContentBlock[];
  isError?: boolean;
}

export type CanonicalEvent =
  | AgentMessageEvent
  | AgentThinkingEvent
  | AgentToolUseEvent
  | AgentToolResultEvent
  | AgentMcpToolUseEvent
  | AgentMcpToolResultEvent;

// ─── Streaming agent events ──────────────────────────────────────────────────

export interface AgentMessageStreamStartEvent extends BaseEvent {
  type: "agent.message_stream_start";
}

export interface AgentMessageChunkEvent extends BaseEvent {
  type: "agent.message_chunk";
  text: string;
}

export interface AgentMessageStreamEndEvent extends BaseEvent {
  type: "agent.message_stream_end";
}

export interface AgentThinkingStreamStartEvent extends BaseEvent {
  type: "agent.thinking_stream_start";
}

export interface AgentThinkingChunkEvent extends BaseEvent {
  type: "agent.thinking_chunk";
  text: string;
}

export interface AgentThinkingStreamEndEvent extends BaseEvent {
  type: "agent.thinking_stream_end";
}

export interface AgentToolUseInputStreamStartEvent extends BaseEvent {
  type: "agent.tool_use_input_stream_start";
  toolUseId: string;
  name: string;
}

export interface AgentToolUseInputChunkEvent extends BaseEvent {
  type: "agent.tool_use_input_chunk";
  toolUseId: string;
  delta: string;
}

export interface AgentToolUseInputStreamEndEvent extends BaseEvent {
  type: "agent.tool_use_input_stream_end";
  toolUseId: string;
}

export type StreamEvent =
  | AgentMessageStreamStartEvent
  | AgentMessageChunkEvent
  | AgentMessageStreamEndEvent
  | AgentThinkingStreamStartEvent
  | AgentThinkingChunkEvent
  | AgentThinkingStreamEndEvent
  | AgentToolUseInputStreamStartEvent
  | AgentToolUseInputChunkEvent
  | AgentToolUseInputStreamEndEvent;

// ─── Union ───────────────────────────────────────────────────────────────────

export type SessionEvent =
  | LifecycleEvent
  | SpanEvent
  | CanonicalEvent
  | StreamEvent;
