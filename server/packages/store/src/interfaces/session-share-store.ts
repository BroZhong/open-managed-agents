/** A share is a read capability; Tenant and Workspace are resolved from its Session. */
export interface SessionShare { id: string; sessionId: string }
export interface SessionShareStore {
  getById(id: string): Promise<SessionShare | null>;
  /** Atomic and idempotent across concurrent callers and Host restarts. */
  getOrCreate(sessionId: string): Promise<SessionShare>;
}
