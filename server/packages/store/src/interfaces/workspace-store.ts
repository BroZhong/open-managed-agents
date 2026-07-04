import type { Workspace } from "../types.js";

export interface WorkspaceStoreCreateInput {
  tenantId: string;
  /**
   * Optional user-supplied Workspace ID. Used as-is when provided; otherwise a
   * Workspace ID is auto-generated. There is only one kind of Workspace.
   */
  id?: string;
}

export interface WorkspaceStore {
  /**
   * Create a Workspace, or return the existing one if a Workspace with the
   * given (tenant-scoped) id already exists. This makes binding to a
   * user-supplied Workspace ID idempotent — the same Workspace can be bound by
   * many Sessions concurrently.
   */
  create(input: WorkspaceStoreCreateInput): Promise<Workspace>;
  getById(tenantId: string, id: string): Promise<Workspace | null>;
}
