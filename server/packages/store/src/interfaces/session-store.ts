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
}

export interface SessionStore {
  create(input: SessionStoreCreateInput): Promise<Session>;
  getById(id: string): Promise<Session | null>;
  list(tenantId: string, opts?: SessionStoreListOpts): Promise<PaginatedResult<Session>>;
  updateStatus(id: string, status: SessionStatus): Promise<Session | null>;
  terminate(id: string): Promise<Session | null>;
}
