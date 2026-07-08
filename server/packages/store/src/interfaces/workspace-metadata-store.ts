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
  /**
   * List a tenant's Workspaces ordered by `createdAt` ascending. Returns a
   * plain array (not a PaginatedResult): Workspaces are few per tenant, so
   * cursor pagination is unnecessary — kept intentionally simpler than the
   * agent/session list surfaces.
   */
  list(tenantId: string): Promise<Workspace[]>;
}
