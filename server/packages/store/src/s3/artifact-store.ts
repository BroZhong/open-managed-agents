import type {
  Artifact,
  ArtifactContent,
  ArtifactPutInput,
  ArtifactStore,
} from "../interfaces/artifact-store.js";

export interface S3ArtifactStoreOptions {
  /**
   * Supabase Storage REST base, e.g. `http://172.17.108.247:80/storage/v1`.
   * Configurable per environment; no default endpoint is hardcoded.
   */
  endpoint: string;
  /** service_role JWT used as `Authorization: Bearer <serviceKey>`. */
  serviceKey: string;
  /** Storage bucket. Defaults to `workspace`. */
  bucket?: string;
  /** Injectable fetch (defaults to global fetch) — the seam mocked in tests. */
  fetch?: typeof fetch;
}

/** Shape of an entry returned by Supabase Storage's `object/list` endpoint. */
interface SupabaseListEntry {
  name: string;
  id?: string | null;
  updated_at?: string | null;
  metadata?: { size?: number; mimetype?: string } | null;
}

const DEFAULT_BUCKET = "workspace";
const LIST_PAGE_SIZE = 1000;

/**
 * Normalize a workspace-relative path: strip leading slashes and collapse the
 * `.`/`..` risk by rejecting traversal, so a caller can never escape its
 * tenant+workspace prefix.
 */
function normalizePath(path: string): string {
  const trimmed = path.replace(/^\/+/, "");
  const segments = trimmed.split("/");
  if (segments.some((s) => s === "." || s === "..")) {
    throw new Error(`Invalid artifact path: ${path}`);
  }
  return trimmed;
}

function toBytes(body: Uint8Array | string): Uint8Array {
  return typeof body === "string" ? new TextEncoder().encode(body) : body;
}

/**
 * S3-authoritative artifact store backed by Supabase Storage.
 *
 * Every key is prefixed `<tenantId>/<workspaceId>/<path>`, which is the only
 * mechanism enforcing cross-tenant / cross-workspace isolation: a caller
 * scoped to (tenant, workspace) can neither list, read, write, nor delete
 * outside its own prefix. See ADR-0002 §4/§5.
 */
export class S3ArtifactStore implements ArtifactStore {
  private readonly endpoint: string;
  private readonly serviceKey: string;
  private readonly bucket: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: S3ArtifactStoreOptions) {
    if (!opts.endpoint) throw new Error("S3ArtifactStore: endpoint is required");
    if (!opts.serviceKey) throw new Error("S3ArtifactStore: serviceKey is required");
    this.endpoint = opts.endpoint.replace(/\/+$/, "");
    this.serviceKey = opts.serviceKey;
    this.bucket = opts.bucket ?? DEFAULT_BUCKET;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** `<tenantId>/<workspaceId>` — the isolation boundary for a workspace. */
  private workspacePrefix(tenantId: string, workspaceId: string): string {
    return `${encodeURIComponent(tenantId)}/${encodeURIComponent(workspaceId)}`;
  }

  /** Full object key: `<tenantId>/<workspaceId>/<path>`. */
  private key(tenantId: string, workspaceId: string, path: string): string {
    return `${this.workspacePrefix(tenantId, workspaceId)}/${normalizePath(path)}`;
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.serviceKey}` };
  }

  private objectUrl(key: string): string {
    // Path segments are pre-encoded per component.
    return `${this.endpoint}/object/${this.bucket}/${key}`;
  }

  async list(tenantId: string, workspaceId: string, prefix = ""): Promise<Artifact[]> {
    const wsPrefix = this.workspacePrefix(tenantId, workspaceId);
    const relPrefix = prefix ? normalizePath(prefix) : "";
    // Supabase list is scoped to a prefix inside the bucket. We always scope to
    // the workspace prefix, so results can never span another tenant/workspace.
    const listPrefix = relPrefix ? `${wsPrefix}/${relPrefix}` : `${wsPrefix}/`;

    const results: Artifact[] = [];
    let offset = 0;
    for (;;) {
      const res = await this.fetchImpl(`${this.endpoint}/object/list/${this.bucket}`, {
        method: "POST",
        headers: { ...this.authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          prefix: listPrefix,
          limit: LIST_PAGE_SIZE,
          offset,
        }),
      });
      if (!res.ok) {
        throw new Error(`S3ArtifactStore.list failed: ${res.status} ${await safeText(res)}`);
      }
      const entries = (await res.json()) as SupabaseListEntry[];
      for (const entry of entries) {
        // Skip folder placeholders (no metadata) that Supabase may emit.
        if (entry.id == null && entry.metadata == null) continue;
        const fullKey = `${listPrefix}${entry.name}`;
        const relPath = fullKey.slice(wsPrefix.length + 1);
        results.push({
          path: relPath,
          size: entry.metadata?.size ?? 0,
          updatedAt: entry.updated_at ? new Date(entry.updated_at) : undefined,
        });
      }
      if (entries.length < LIST_PAGE_SIZE) break;
      offset += entries.length;
    }
    return results;
  }

  async get(
    tenantId: string,
    workspaceId: string,
    path: string,
  ): Promise<ArtifactContent | null> {
    const key = this.key(tenantId, workspaceId, path);
    const res = await this.fetchImpl(this.objectUrl(key), {
      method: "GET",
      headers: this.authHeaders(),
    });
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok) {
      throw new Error(`S3ArtifactStore.get failed: ${res.status} ${await safeText(res)}`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    return {
      path: normalizePath(path),
      body: buf,
      contentType: res.headers.get("content-type") ?? undefined,
    };
  }

  async put(input: ArtifactPutInput): Promise<Artifact> {
    const key = this.key(input.tenantId, input.workspaceId, input.path);
    const body = toBytes(input.body);
    const res = await this.fetchImpl(this.objectUrl(key), {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        "Content-Type": input.contentType ?? "application/octet-stream",
        // Overwrite if present — the store is authoritative and idempotent.
        "x-upsert": "true",
      },
      // Uint8Array is a valid BodyInit at runtime; cast to satisfy the
      // lib.dom fetch signature across TS/Node type versions.
      body: body as unknown as BodyInit,
    });
    if (!res.ok) {
      throw new Error(`S3ArtifactStore.put failed: ${res.status} ${await safeText(res)}`);
    }
    return { path: normalizePath(input.path), size: body.byteLength };
  }

  async delete(tenantId: string, workspaceId: string, path: string): Promise<boolean> {
    const key = this.key(tenantId, workspaceId, path);
    const res = await this.fetchImpl(this.objectUrl(key), {
      method: "DELETE",
      headers: this.authHeaders(),
    });
    if (res.status === 404 || res.status === 400) return false;
    if (!res.ok) {
      throw new Error(`S3ArtifactStore.delete failed: ${res.status} ${await safeText(res)}`);
    }
    return true;
  }
}

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
