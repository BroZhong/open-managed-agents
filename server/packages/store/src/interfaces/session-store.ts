import type { Agent, PaginatedResult, Session, SessionStatus } from "../types.js";

export interface SessionStoreListOpts {
  limit?: number;
  cursor?: string;
  agentId?: string;
  status?: SessionStatus;
}

export interface SessionStoreCreateInput {
  tenantId: string;
  agentId: string;
  agent: Agent;
  /**
   * The Workspace to bind this Session to. Immutable after creation. The
   * caller (session-creation route) is responsible for having created/resolved
   * the Workspace before binding.
   */
  workspaceId: string;
}

export interface SessionStore {
  create(input: SessionStoreCreateInput): Promise<Session>;
  getById(id: string): Promise<Session | null>;
  list(tenantId: string, opts?: SessionStoreListOpts): Promise<PaginatedResult<Session>>;
  updateStatus(id: string, status: SessionStatus): Promise<Session | null>;
  terminate(id: string): Promise<Session | null>;
}
