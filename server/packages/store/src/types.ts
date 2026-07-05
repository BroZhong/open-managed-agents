export type Runtime = "claude-code" | "codex" | "pi-agent" | "mock";

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

export interface AgentSandboxConfig {
  enabled: boolean;
  image?: string;
  /**
   * Environment variables injected into the Agent's sandbox at create time
   * (e.g. a `VFS_TOKEN` a CLI in the sandbox needs). These are baked into the
   * sandbox by the ToolExecutor and never enter the model context or event log
   * — unlike anything passed through a turn's prompt. Per-Agent, so two Agents
   * on the same template get isolated secrets.
   */
  env?: Record<string, string>;
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
  sandbox?: AgentSandboxConfig;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A Workspace is the S3-authoritative home of a Session's artifacts.
 *
 * There is only one kind of Workspace: a user-supplied ID is used as-is, and
 * an unspecified one is auto-created (same entity, just an auto-generated ID).
 * A Workspace belongs to a tenant. A Session binds exactly one Workspace
 * immutably at creation; a single Workspace may be bound by many Sessions
 * concurrently (collisions are the user's responsibility). See ADR-0002 §4.
 */
export interface Workspace {
  id: string;
  tenantId: string;
  /** Optional human-friendly name. Set at creation; not renamable (out of scope). */
  name?: string;
  createdAt: Date;
}

export type SessionStatus = "idle" | "running" | "terminated";

export interface Session {
  id: string;
  tenantId: string;
  agentId: string;
  status: SessionStatus;
  /**
   * A truncated snapshot of the user's first message, set when that first
   * message arrives. Optional: historical sessions may have none. The console
   * shows `title ?? id`.
   */
  title?: string;
  /** Snapshot of the Agent at session creation time */
  agent: Agent;
  /** The Workspace this Session is bound to. Immutable after creation. */
  workspaceId: string;
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

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  tenantId: string;
  createdAt: Date;
}

export interface PaginatedResult<T> {
  data: T[];
  hasMore: boolean;
}
