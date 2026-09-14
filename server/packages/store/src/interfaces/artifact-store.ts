/**
 * A single artifact stored under a Workspace prefix.
 *
 * `path` is the workspace-relative path (never includes the tenant/workspace
 * prefix — that is an implementation detail of the store's key layout).
 */
export interface Artifact {
  path: string;
  size: number;
  /** Last-modified timestamp, when the backend reports one. */
  updatedAt?: Date;
}

export interface ArtifactContent {
  path: string;
  body: Uint8Array;
  contentType?: string;
}

export interface ArtifactPutInput {
  tenantId: string;
  workspaceId: string;
  path: string;
  body: Uint8Array | string;
  contentType?: string;
}

/**
 * Workspace artifact storage, keyed by tenant + workspace + path.
 *
 * Implementations MUST prefix every key using the trusted
 * `workspaceObjectPrefix(tenantId, workspaceId)` contract plus a validated path
 * so that cross-tenant and cross-workspace access is isolated: a caller can
 * only ever see or mutate objects under its own tenant+workspace prefix.
 * Callers must first verify that the Workspace belongs to the authenticated Tenant.
 */
export interface ArtifactStore {
  /** List artifacts under a Workspace prefix (ListObjects). */
  list(tenantId: string, workspaceId: string, prefix?: string): Promise<Artifact[]>;
  /** Fetch a single artifact's content. Returns null if absent. */
  get(tenantId: string, workspaceId: string, path: string): Promise<ArtifactContent | null>;
  /** Check whether an artifact exists without fetching its body. */
  exists(tenantId: string, workspaceId: string, path: string): Promise<boolean>;
  /** Write (create or overwrite) an artifact. */
  put(input: ArtifactPutInput): Promise<Artifact>;
  /** Delete an artifact. Returns true if it existed. */
  delete(tenantId: string, workspaceId: string, path: string): Promise<boolean>;
  /**
   * Sign a short-lived, read-only GET URL for a file. Returns an absolute,
   * publicly-reachable URL. Optional: only backends that support presigned
   * reads implement it. Never signs writes (ADR-0006).
   */
  createSignedReadUrl?(
    tenantId: string,
    workspaceId: string,
    path: string,
    expiresInSec: number,
  ): Promise<string>;
}
