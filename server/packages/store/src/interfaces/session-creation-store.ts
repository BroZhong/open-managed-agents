import type { Agent, Session } from "../types.js";

/** Normalized caller input, before resolving mutable Agent defaults. */
export interface SessionCreationRequest {
  agentId: string;
  workspaceId?: string;
  workspaceName?: string;
  environmentId?: string;
}

export interface SessionCreationStore {
  /** Atomically reserve the key and create the Workspace and Session. Failed
   * attempts consume no key. Replay bypasses prepare and returns current state.
   * Keys are tenant-scoped and retained without an automatic expiry. */
  create(
    tenantId: string,
    key: string,
    request: SessionCreationRequest,
    prepare: () => Promise<{ agent: Agent; environmentId?: string }>,
  ): Promise<Session>;
}

export function sessionCreationFingerprint(request: SessionCreationRequest): string {
  return JSON.stringify([request.agentId, request.workspaceId ?? null,
    request.workspaceName ?? null, request.environmentId ?? null]);
}

export class SessionCreationConflictError extends Error {
  readonly code = "idempotency_key_conflict";
  constructor(readonly sessionId: string) {
    super("This Idempotency-Key was already used with different Session creation parameters.");
    this.name = "SessionCreationConflictError";
  }
}

export class SessionWorkspaceDeletedError extends Error {
  constructor() { super("Workspace has been deleted"); }
}
