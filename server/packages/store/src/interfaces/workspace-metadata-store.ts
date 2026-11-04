import type { Workspace } from "../types.js";

export interface WorkspaceMetadataStoreCreateInput {
  tenantId: string;
  /**
   * Optional user-supplied Workspace ID. Used as-is when provided; otherwise a
   * Workspace ID is auto-generated. There is only one kind of Workspace.
   */
  id?: string;
  /**
   * Optional human-friendly name. Only applied when the Workspace is newly
   * created; on idempotent re-create (existing id) it is NOT overwritten (see
   * `create`). Rename an existing Workspace via {@link WorkspaceMetadataStore.update}.
   */
  name?: string;
}

export interface WorkspaceMetadataStoreUpdateInput {
  /** New human-friendly name. */
  name?: string;
}

export interface AgentWorkspace extends Workspace {
  updatedAt: Date;
  hasRunningSessions: boolean;
}

export interface AgentWorkspaceListOptions {
  limit: number;
  cursor?: string;
}

export interface AgentWorkspaceListResult {
  data: AgentWorkspace[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface WorkspaceMetadataStore {
  /**
   * Create a Workspace, or return the existing one if a Workspace with the
   * given (tenant-scoped) id already exists. This makes binding to a
   * user-supplied Workspace ID idempotent — the same Workspace can be bound by
   * many Sessions concurrently.
   *
   * Idempotent-name semantics: the backing INSERT uses ON CONFLICT DO NOTHING,
   * so when a Workspace with (tenant, id) already exists it is returned as-is —
   * a `name` passed on a colliding create does NOT overwrite the stored name.
   */
  create(input: WorkspaceMetadataStoreCreateInput): Promise<Workspace>;
  getById(tenantId: string, id: string): Promise<Workspace | null>;
  /**
   * Update a Workspace's mutable fields (currently just `name`). Returns the
   * updated Workspace, or null if no Workspace with the given (tenant, id)
   * exists.
   */
  update(
    tenantId: string,
    id: string,
    input: WorkspaceMetadataStoreUpdateInput,
  ): Promise<Workspace | null>;
  /** Unfiltered tenant inventory, ordered by creation time ascending. */
  list(tenantId: string, includeDeleted?: boolean): Promise<Workspace[]>;
  /** Visible named Workspaces ordered by this Agent's latest Session update, then ID, descending. */
  listByAgent(tenantId: string, agentId: string, opts: AgentWorkspaceListOptions): Promise<AgentWorkspaceListResult>;
  softDelete(tenantId: string, id: string): Promise<Workspace | null>;
}
