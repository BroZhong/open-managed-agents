import type { SessionCreationStore, WorkspaceMetadataStore } from "@oma-server/store";
import { sessionCreationFingerprint, SessionCreationConflictError, SessionWorkspaceDeletedError } from "@oma-server/store";
import type { InMemorySessionStore } from "./session-store.js";

/** Serializes the composed memory transaction, including failure compensation. */
export class InMemorySessionCreationStore implements SessionCreationStore {
  private keys = new Map<string, { request: string; sessionId: string }>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly sessions: InMemorySessionStore,
    private readonly workspaces: WorkspaceMetadataStore & { delete(tenantId: string, id: string): Promise<boolean> },
  ) {}

  create(...[tenantId, key, request, prepare]: Parameters<SessionCreationStore["create"]>) {
    const operation = this.tail.then(async () => {
      const identity = JSON.stringify([tenantId, key]);
      const fingerprint = sessionCreationFingerprint(request);
      const existing = this.keys.get(identity);
      if (existing) {
        if (existing.request !== fingerprint) throw new SessionCreationConflictError(existing.sessionId);
        const session = await this.sessions.getById(existing.sessionId);
        if (!session) throw new Error("Idempotent Session is missing");
        return session;
      }
      const prepared = await prepare();
      const previous = request.workspaceId === undefined ? null : await this.workspaces.getById(tenantId, request.workspaceId);
      const workspace = await this.workspaces.create({ tenantId, id: request.workspaceId, name: request.workspaceName });
      if (workspace.deletedAt) throw new SessionWorkspaceDeletedError();
      try {
        const session = await this.sessions.create({ tenantId, agentId: prepared.agent.id, ...prepared, workspaceId: workspace.id });
        this.keys.set(identity, { request: fingerprint, sessionId: session.id });
        return session;
      } catch (error) {
        if (!previous) await this.workspaces.delete(tenantId, workspace.id);
        throw error;
      }
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
}
