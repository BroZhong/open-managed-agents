import { encodeWorkspaceUpdatedAtCursor, decodeWorkspaceUpdatedAtCursor } from "@oma-server/store";
import type {
  AgentWorkspace,
  AgentWorkspaceListOptions,
  AgentWorkspaceListResult,
  SessionStore,
  Workspace,
  WorkspaceMetadataStore,
  WorkspaceMetadataStoreCreateInput,
  WorkspaceMetadataStoreUpdateInput,
} from "@oma-server/store";

/**
 * In-memory WorkspaceMetadataStore for `dev:memory` and tests.
 *
 * Workspaces are tenant-scoped; a user-supplied id is used as-is (idempotently,
 * so many Sessions can share one Workspace), else auto-generated.
 */
export class InMemoryWorkspaceMetadataStore implements WorkspaceMetadataStore {
  private workspaces = new Map<string, Workspace>();
  private nextId = 1;

  constructor(private readonly sessions?: Pick<SessionStore, "list">) {}

  private key(tenantId: string, id: string): string {
    return `${tenantId}\u0000${id}`;
  }

  async create(input: WorkspaceMetadataStoreCreateInput): Promise<Workspace> {
    const id = input.id ?? `ws_${this.nextId++}`;
    const key = this.key(input.tenantId, id);
    const existing = this.workspaces.get(key);
    // Idempotent: existing Workspace is returned as-is; a `name` passed on a
    // colliding create does NOT overwrite the stored name (matches PG's
    // ON CONFLICT DO NOTHING).
    if (existing) return existing;

    const workspace: Workspace = {
      id,
      tenantId: input.tenantId,
      createdAt: new Date(),
    };
    if (input.name != null) workspace.name = input.name;
    this.workspaces.set(key, workspace);
    return workspace;
  }

  async getById(tenantId: string, id: string): Promise<Workspace | null> {
    return this.workspaces.get(this.key(tenantId, id)) ?? null;
  }

  async list(tenantId: string, includeDeleted = false): Promise<Workspace[]> {
    return [...this.workspaces.values()]
      .filter((w) => w.tenantId === tenantId && (includeDeleted || !w.deletedAt))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async listByAgent(tenantId: string, agentId: string, opts: AgentWorkspaceListOptions): Promise<AgentWorkspaceListResult> {
    const cursor = opts.cursor ? decodeWorkspaceUpdatedAtCursor(opts.cursor) : null;
    if (opts.cursor && !cursor) return { data: [], hasMore: false };
    if (!this.sessions) throw new Error("Session discovery is unavailable");
    const matches: AgentWorkspace[] = [];
    for (const workspace of await this.list(tenantId)) {
      if (!workspace.name) continue;
      const filters = { agentId, workspaceId: workspace.id, withoutLoop: true, excludeDelegated: true, order: "updated_at" as const, limit: 1 };
      const latest = (await this.sessions.list(tenantId, filters)).data[0];
      if (!latest) continue;
      const active = await Promise.all((["running", "waiting"] as const).map((status) => this.sessions!.list(tenantId, { ...filters, status })));
      matches.push({ ...workspace, updatedAt: latest.updatedAt, hasRunningSessions: active.some((page) => page.data.length > 0) });
    }
    const sorted = matches.filter((workspace) => !cursor || workspace.updatedAt.getTime() < Date.parse(cursor.updatedAt)
      || (workspace.updatedAt.getTime() === Date.parse(cursor.updatedAt) && workspace.id < cursor.id))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const data = sorted.slice(0, opts.limit);
    const hasMore = sorted.length > opts.limit;
    const last = data.at(-1);
    return { data, hasMore, ...(hasMore && last ? { nextCursor: encodeWorkspaceUpdatedAtCursor(last.updatedAt.toISOString(), last.id) } : {}) };
  }

  async softDelete(tenantId: string, id: string): Promise<Workspace | null> {
    const workspace = this.workspaces.get(this.key(tenantId, id));
    if (!workspace) return null;
    workspace.deletedAt ??= new Date();
    return workspace;
  }

  async update(
    tenantId: string,
    id: string,
    input: WorkspaceMetadataStoreUpdateInput,
  ): Promise<Workspace | null> {
    const workspace = this.workspaces.get(this.key(tenantId, id));
    if (!workspace) return null;
    if (input.name !== undefined) workspace.name = input.name;
    return workspace;
  }

  /** Internal compensation hook used by the in-memory Loop transaction. */
  async delete(tenantId: string, id: string): Promise<boolean> {
    return this.workspaces.delete(this.key(tenantId, id));
  }
}
