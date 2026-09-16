import type {
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
