import type {
  Artifact,
  ArtifactContent,
  ArtifactPutInput,
  ArtifactStore,
} from "../interfaces/artifact-store.js";
import {
  SupabaseStorageClient,
  normalizePath,
  toBytes,
  type SupabaseStorageOptions,
} from "./supabase-storage.js";

export interface S3ArtifactStoreOptions extends SupabaseStorageOptions {
  /**
   * Publicly-reachable Storage base (the instance's `public_url` + `/storage/v1`,
   * e.g. `http://47.252.145.10:80/storage/v1`), onto which a relative signedURL
   * is prefixed to form an absolute, browser-reachable GET URL. The client signs
   * on the internal `endpoint`; this base is where the browser downloads. Absent
   * → `createSignedReadUrl` is unavailable (signing without a reachable base is
   * useless). Wired from `STORAGE_PUBLIC_BASE`. See ADR-0006 §1, research #88 §3/§5.
   */
  publicBase?: string;
}

/**
 * S3-authoritative artifact storage backed by Supabase Storage.
 *
 * Every key is prefixed `<tenantId>/<workspaceId>/<path>`, which is the only
 * mechanism enforcing cross-tenant / cross-workspace isolation: a caller
 * scoped to (tenant, workspace) can neither list, read, write, nor delete
 * outside its own prefix. See ADR-0002 §4/§5. Shares the Supabase wire logic
 * with the Skill artifact store via {@link SupabaseStorageClient}.
 */
export class S3ArtifactStore implements ArtifactStore {
  private readonly client: SupabaseStorageClient;
  private readonly publicBase?: string;

  constructor(opts: S3ArtifactStoreOptions) {
    this.client = new SupabaseStorageClient(opts, "S3ArtifactStore");
    this.publicBase = opts.publicBase?.replace(/\/+$/, "") || undefined;
  }

  /** `<tenantId>/<workspaceId>` — the isolation boundary for a workspace. */
  private workspacePrefix(tenantId: string, workspaceId: string): string {
    return `${encodeURIComponent(tenantId)}/${encodeURIComponent(workspaceId)}`;
  }

  /** Full object key: `<tenantId>/<workspaceId>/<path>`. */
  private key(tenantId: string, workspaceId: string, path: string): string {
    return `${this.workspacePrefix(tenantId, workspaceId)}/${normalizePath(path)}`;
  }

  async list(tenantId: string, workspaceId: string, prefix = ""): Promise<Artifact[]> {
    const wsPrefix = this.workspacePrefix(tenantId, workspaceId);
    const relPrefix = prefix ? normalizePath(prefix) : "";
    const listPrefix = relPrefix ? `${wsPrefix}/${relPrefix}` : `${wsPrefix}/`;

    const results: Artifact[] = [];
    await this.client.listRecursiveDetailed(listPrefix, (fullKey, size, updatedAt) => {
      results.push({
        path: fullKey.slice(wsPrefix.length + 1),
        size,
        updatedAt: updatedAt ? new Date(updatedAt) : undefined,
      });
    });
    return results;
  }

  async get(
    tenantId: string,
    workspaceId: string,
    path: string,
  ): Promise<ArtifactContent | null> {
    const obj = await this.client.getObject(this.key(tenantId, workspaceId, path));
    if (!obj) return null;
    return { path: normalizePath(path), body: obj.body, contentType: obj.contentType };
  }

  async exists(tenantId: string, workspaceId: string, path: string): Promise<boolean> {
    return this.client.objectExists(this.key(tenantId, workspaceId, path));
  }

  async put(input: ArtifactPutInput): Promise<Artifact> {
    const body = toBytes(input.body);
    await this.client.putObject(
      this.key(input.tenantId, input.workspaceId, input.path),
      body,
      input.contentType,
    );
    return { path: normalizePath(input.path), size: body.byteLength };
  }

  async delete(tenantId: string, workspaceId: string, path: string): Promise<boolean> {
    return this.client.deleteObject(this.key(tenantId, workspaceId, path));
  }

  /**
   * Sign a short-lived, read-only GET URL for `<tenantId>/<workspaceId>/<path>`.
   * The client signs on the internal endpoint (bucket stays private); we then
   * prefix the relative signedURL with the configured public base to form an
   * absolute, browser-reachable URL. Read-only — never signs writes (ADR-0006 §1/§2).
   * Throws if no public base is configured (signing without a reachable base is
   * useless — the caller should treat this as "presigned reads not available").
   */
  async createSignedReadUrl(
    tenantId: string,
    workspaceId: string,
    path: string,
    expiresInSec: number,
  ): Promise<string> {
    if (!this.publicBase) {
      throw new Error(
        "S3ArtifactStore: publicBase not configured (set STORAGE_PUBLIC_BASE) — cannot sign a reachable URL",
      );
    }
    const signedURL = await this.client.createSignedUrl(
      this.key(tenantId, workspaceId, path),
      expiresInSec,
    );
    return this.publicBase + signedURL;
  }
}
