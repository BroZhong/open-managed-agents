import type { Agent, PaginatedResult, Session, SessionStatus } from "../types.js";
import type { PendingEventFence } from "./pending-event-store.js";

export interface SessionStoreListOpts {
  limit?: number;
  cursor?: string;
  agentId?: string;
  status?: SessionStatus;
  loopId?: string;
  /** Exclude Loop-created Sessions so loose Agent navigation is not crowded out. */
  withoutLoop?: boolean;
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
  loopId?: string;
}

export interface SessionStore {
  create(input: SessionStoreCreateInput): Promise<Session>;
  getById(id: string): Promise<Session | null>;
  list(tenantId: string, opts?: SessionStoreListOpts): Promise<PaginatedResult<Session>>;
  updateStatus(id: string, status: SessionStatus): Promise<Session | null>;
  /** PG-backed fenced variant used by a claimed turn owner. */
  updateStatusIfClaimed?(
    id: string,
    status: SessionStatus,
    fence: PendingEventFence,
  ): Promise<Session | null>;
  /**
   * Set the Session's title (a snapshot of the user's first message). Callers
   * set it once, on the first message, only when it is currently unset.
   */
  setTitle(id: string, title: string): Promise<Session | null>;
  terminate(id: string): Promise<Session | null>;
}
