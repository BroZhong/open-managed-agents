export type Runtime = "claude-code" | "codex" | "pi-agent";

export interface AgentToolConfig {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface AgentMcpServerConfig {
  name: string;
  url: string;
  transport?: "sse" | "streamable-http";
  headers?: Record<string, string>;
}

export interface Agent {
  id: string;
  tenantId: string;
  name: string;
  model: string;
  system: string;
  runtime: Runtime;
  tools?: AgentToolConfig[];
  mcpServers?: AgentMcpServerConfig[];
  skills?: string[];
  createdAt: Date;
  updatedAt: Date;
}

export type SessionStatus = "idle" | "running" | "terminated";

export interface Session {
  id: string;
  tenantId: string;
  agentId: string;
  status: SessionStatus;
  /** Snapshot of the Agent at session creation time */
  agent: Agent;
  createdAt: Date;
  updatedAt: Date;
  terminatedAt?: Date;
}

export interface StoredEvent {
  sessionId: string;
  seq: number;
  type: string;
  data: unknown;
  ts: Date;
  sessionThreadId: string;
}

export interface ApiKey {
  id: string;
  tenantId: string;
  name: string;
  keyHash: string;
  prefix: string;
  createdAt: Date;
}

export interface PaginatedResult<T> {
  data: T[];
  hasMore: boolean;
}
