import type {
  Session,
  SessionStatus,
  SessionStore,
  SessionStoreCreateInput,
  SessionStoreListOpts,
  PaginatedResult,
  PendingEventFence,
} from "@oma-server/store";
import { PendingEventClaimLostError } from "@oma-server/store";

export class InMemorySessionStore implements SessionStore {
  private sessions: Session[] = [];
  private nextId = 1;

  constructor(
    private readonly validateFence?: (
      sessionId: string,
      fence: PendingEventFence,
    ) => Promise<boolean>,
  ) {}

  async create(input: SessionStoreCreateInput): Promise<Session> {
    const session: Session = {
      id: `sess_${this.nextId++}`,
      tenantId: input.tenantId,
      agentId: input.agentId,
      status: "idle",
      agent: structuredClone(input.agent),
      workspaceId: input.workspaceId,
      loopId: input.loopId,
      delegation: input.delegation,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.sessions.push(session);
    return session;
  }

  async getById(id: string): Promise<Session | null> {
    return this.getRecord(id);
  }

  /** Internal synchronous lookup for a composed in-memory transaction. */
  getRecord(id: string): Session | null {
    return this.sessions.find((s) => s.id === id) ?? null;
  }

  async list(
    tenantId: string,
    opts?: SessionStoreListOpts,
  ): Promise<PaginatedResult<Session>> {
    const limit = opts?.limit ?? 50;
    const cursor = opts?.cursor;
    const agentId = opts?.agentId;
    const status = opts?.status;
    const loopId = opts?.loopId;
    const withoutLoop = opts?.withoutLoop;

    let filtered = this.sessions.filter((s) => s.tenantId === tenantId && !s.deletedAt && !opts?.excludedWorkspaceIds?.includes(s.workspaceId));
    if (agentId) filtered = filtered.filter((s) => s.agentId === agentId);
    if (status) filtered = filtered.filter((s) => s.status === status);
    if (loopId) filtered = filtered.filter((s) => s.loopId === loopId);
    if (withoutLoop) filtered = filtered.filter((s) => !s.loopId);
    if (opts?.excludeDelegated) filtered = filtered.filter((s) => !s.delegation);

    if (loopId) {
      filtered = filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    }

    if (cursor) {
      const idx = filtered.findIndex((s) => s.id === cursor);
      if (idx >= 0) filtered = filtered.slice(idx + 1);
    }

    const data = filtered.slice(0, limit);
    const hasMore = filtered.length > limit;
    return { data, hasMore };
  }

  async updateStatus(id: string, status: SessionStatus): Promise<Session | null> {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return null;
    session.status = status;
    session.updatedAt = new Date();
    return session;
  }

  async updateStatusIfClaimed(
    id: string,
    status: SessionStatus,
    fence: PendingEventFence,
  ): Promise<Session | null> {
    if (this.validateFence && !await this.validateFence(id, fence)) {
      throw new PendingEventClaimLostError(
        id,
        fence.eventId,
        fence.ownerId,
        fence.generation,
      );
    }
    const session = await this.getById(id);
    if (!session || session.status === "terminated") return null;
    return this.updateStatus(id, status);
  }

  async setTitle(id: string, title: string): Promise<Session | null> {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return null;
    session.title = title;
    session.updatedAt = new Date();
    return session;
  }

  async softDelete(id: string): Promise<Session | null> {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return null;
    session.deletedAt ??= new Date();
    return session;
  }

  async terminate(id: string): Promise<Session | null> {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return null;
    session.status = "terminated";
    session.terminatedAt = new Date();
    session.updatedAt = new Date();
    return session;
  }

  /** Internal compensation hook used by the in-memory Loop transaction. */
  async delete(id: string): Promise<boolean> {
    const index = this.sessions.findIndex((session) => session.id === id);
    if (index < 0) return false;
    this.sessions.splice(index, 1);
    return true;
  }
  /** Internal rollback boundary for the in-memory delegation transaction. */
  snapshotState() { return structuredClone({ sessions: this.sessions, nextId: this.nextId }); }
  restoreState(state: ReturnType<InMemorySessionStore["snapshotState"]>): void { this.sessions = state.sessions; this.nextId = state.nextId; }

}
