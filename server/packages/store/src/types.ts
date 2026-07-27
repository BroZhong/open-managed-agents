export type Runtime = "claude-code" | "codex" | "pi-agent" | "mock";

export interface AgentToolConfig {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/**
 * A reference to a Host-reviewed MCP connection. Runtime command/URL details
 * are deliberately absent: the Host resolves them from its managed catalog on
 * every Turn, so an Agent definition can never smuggle in a Host command.
 */
export interface ManagedMcpServerRef {
  catalogId: string;
  name: string;
  description?: string;
}

/** Legacy persisted RDS entries remain readable while the console migrates them. */
export interface LegacyHttpMcpServerConfig {
  name: string;
  url: string;
  transport?: "sse" | "streamable-http";
  headers?: Record<string, string>;
}

export type AgentMcpServerConfig = ManagedMcpServerRef | LegacyHttpMcpServerConfig;

export interface AgentSandboxConfig {
  enabled: boolean;
  image?: string;
  /**
   * Whether `/home/user` is hydrated from and synced back to the Workspace
   * medium. Defaults to `durable`. `ephemeral` keeps one live sandbox across
   * turns but deliberately skips Workspace persistence; use it for Agents
   * whose authoritative state lives behind an external CLI/API.
   */
  workspacePersistence?: "durable" | "ephemeral";
  /**
   * `runtime-vfs` removes VFS_TOKEN from every create-time env source and
   * requires the per-Pending-Event runtime credential seam.
   */
  credentialMode?: "runtime-vfs";
  /**
   * Non-sensitive environment variables injected into the Agent's sandbox at
   * create time. They are readable by sandbox processes and model-invoked shell
   * commands, so credentials must use a Host-owned runtime credential seam
   * instead of this field.
   */
  env?: Record<string, string>;
}

export interface Agent {
  id: string;
  tenantId: string;
  name: string;
  /**
   * Optional human-readable description of the Agent, shown in the console
   * (cards, detail) to help people tell Agents apart. Purely informational:
   * it is NOT injected into the model context / prompt.
   */
  description?: string;
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
  /** Set only for Sessions automatically created by a Loop trigger. */
  loopId?: string;
  createdAt: Date;
  updatedAt: Date;
  terminatedAt?: Date;
}

/**
 * An Agent-owned recurring instruction. Each trigger creates a fresh Session;
 * prior Loop Sessions remain immutable history under the same Loop.
 */
export interface Loop {
  id: string;
  tenantId: string;
  agentId: string;
  name: string;
  description?: string;
  prompt: string;
  intervalMinutes: number;
  enabled: boolean;
  nextRunAt: Date;
  lastRunAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface LoopDispatch {
  loop: Loop;
  session: Session;
}

export interface StoredEvent {
  sessionId: string;
  seq: number;
  type: string;
  data: unknown;
  ts: Date;
  sessionThreadId: string;
}

/** Aggregated, provider-neutral token accounting over durable model spans. */
export interface TokenUsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cacheHitRate: number | null;
}

export interface ApiKey {
  id: string;
  tenantId: string;
  name: string;
  keyHash: string;
  prefix: string;
  createdAt: Date;
  /** Revoked keys remain listable so their historical usage stays attributable. */
  revokedAt?: Date;
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
