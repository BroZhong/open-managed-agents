/**
 * Shared Supabase Storage REST primitives, used by both the Workspace artifact
 * store and the Skill artifact store (which differ only in their key prefix).
 * Keeping the request/list/normalize logic in one place avoids duplicating the
 * Supabase wire details across the two stores.
 */

export interface SupabaseStorageOptions {
  /** Supabase Storage REST base, e.g. `http://host:80/storage/v1`. */
  endpoint: string;
  /** service_role JWT used as `Authorization: Bearer <serviceKey>`. */
  serviceKey: string;
  /** Storage bucket. Defaults to `workspace`. */
  bucket?: string;
  /** Injectable fetch (defaults to global fetch) — the seam mocked in tests. */
  fetch?: typeof fetch;
}

/** An entry returned by Supabase Storage's `object/list` endpoint. */
export interface SupabaseListEntry {
  name: string;
  id?: string | null;
  updated_at?: string | null;
  metadata?: { size?: number; mimetype?: string } | null;
}

export interface SupabaseObjectInfo {
  userMetadata: Record<string, unknown> | null;
}

export const DEFAULT_BUCKET = "workspace";
const LIST_PAGE_SIZE = 1000;

/**
 * Normalize a store-relative path: strip leading slashes and reject `.`/`..`
 * traversal, so a caller can never escape its tenant-scoped key prefix.
 */
export function normalizePath(path: string, label = "artifact"): string {
  const trimmed = path.replace(/^\/+/, "");
  const segments = trimmed.split("/");
  if (segments.some((s) => s === "." || s === "..")) {
    throw new Error(`Invalid ${label} path: ${path}`);
  }
  return trimmed;
}

export function toBytes(body: Uint8Array | string): Uint8Array {
  return typeof body === "string" ? new TextEncoder().encode(body) : body;
}

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/** A thin authenticated client over a single Supabase Storage bucket. */
export class SupabaseStorageClient {
  readonly bucket: string;
  private readonly endpoint: string;
  private readonly serviceKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SupabaseStorageOptions, who: string) {
    if (!opts.endpoint) throw new Error(`${who}: endpoint is required`);
    if (!opts.serviceKey) throw new Error(`${who}: serviceKey is required`);
    this.endpoint = opts.endpoint.replace(/\/+$/, "");
    this.serviceKey = opts.serviceKey;
    this.bucket = opts.bucket ?? DEFAULT_BUCKET;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.serviceKey}` };
  }

  private encodeUrlPath(path: string): string {
    return path.split("/").map(encodeURIComponent).join("/");
  }

  private objectUrl(key: string): string {
    return (
      `${this.endpoint}/object/${encodeURIComponent(this.bucket)}/` +
      this.encodeUrlPath(key)
    );
  }

  /** Upsert an object at an absolute (already-prefixed) key. */
  async putObject(
    key: string,
    body: Uint8Array,
    contentType?: string,
    userMetadata?: Record<string, unknown>,
  ): Promise<void> {
    const res = await this.fetchImpl(this.objectUrl(key), {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        "Content-Type": contentType ?? "application/octet-stream",
        "x-upsert": "true",
        ...(userMetadata
          ? {
              "x-metadata": Buffer.from(JSON.stringify(userMetadata), "utf8").toString(
                "base64",
              ),
            }
          : {}),
      },
      body: body as unknown as BodyInit,
    });
    if (!res.ok) {
      throw new Error(`Supabase putObject failed: ${res.status} ${await safeText(res)}`);
    }
  }

  /** Fetch an object's bytes + content-type, or null if absent. */
  async getObject(key: string): Promise<{ body: Uint8Array; contentType?: string } | null> {
    const res = await this.fetchImpl(this.objectUrl(key), {
      method: "GET",
      headers: this.authHeaders(),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Supabase getObject failed: ${res.status} ${await safeText(res)}`);
    }
    return {
      body: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") ?? undefined,
    };
  }

  /** Check object existence without transferring its body. */
  async objectExists(key: string): Promise<boolean> {
    const res = await this.fetchImpl(this.objectUrl(key), {
      method: "HEAD",
      headers: this.authHeaders(),
    });
    if (res.status === 404) return false;
    if (!res.ok) {
      const detail = await safeText(res);
      throw new Error(`Supabase objectExists failed: ${res.status} ${detail}`);
    }
    return true;
  }

  /** Fetch the custom metadata needed to disambiguate codec and legacy keys. */
  async getObjectInfo(
    key: string,
    opts: { invalidKeyAsMissing?: boolean } = {},
  ): Promise<SupabaseObjectInfo | null> {
    const res = await this.fetchImpl(
      `${this.endpoint}/object/info/authenticated/${encodeURIComponent(this.bucket)}/` +
        this.encodeUrlPath(key),
      {
        method: "GET",
        headers: this.authHeaders(),
      },
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      const detail = await safeText(res);
      if (
        res.status === 400 &&
        opts.invalidKeyAsMissing &&
        /"(?:error|code)"\s*:\s*"InvalidKey"/.test(detail)
      ) {
        return null;
      }
      throw new Error(`Supabase getObjectInfo failed: ${res.status} ${detail}`);
    }
    const info = (await res.json()) as { metadata?: Record<string, unknown> | null };
    return { userMetadata: info.metadata ?? null };
  }

  /** Delete an object. Returns true if it existed. */
  async deleteObject(key: string): Promise<boolean> {
    const res = await this.fetchImpl(this.objectUrl(key), {
      method: "DELETE",
      headers: this.authHeaders(),
    });
    if (res.status === 404) return false;
    if (!res.ok) {
      throw new Error(`Supabase deleteObject failed: ${res.status} ${await safeText(res)}`);
    }
    return true;
  }

  /**
   * Sign a short-lived download URL for an already-prefixed key. Returns the
   * relative signedURL (caller prefixes the public base). Signs on the internal
   * endpoint; the bucket stays private. Read-only — never signs writes.
   */
  async createSignedUrl(key: string, expiresInSec: number): Promise<string> {
    const res = await this.fetchImpl(
      `${this.endpoint}/object/sign/${encodeURIComponent(this.bucket)}/` +
        this.encodeUrlPath(key),
      {
        method: "POST",
        headers: { ...this.authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ expiresIn: expiresInSec }),
      },
    );
    if (!res.ok) throw new Error(`Supabase sign failed: ${res.status} ${await safeText(res)}`);
    const { signedURL } = (await res.json()) as { signedURL: string };
    return signedURL;
  }

  /**
   * Recursively list files under `listPrefix` (Supabase's list is not
   * recursive), invoking `onFile(fullKey)` for each concrete file.
   */
  async listRecursive(listPrefix: string, onFile: (fullKey: string) => void): Promise<void> {
    let offset = 0;
    for (;;) {
      const res = await this.fetchImpl(
        `${this.endpoint}/object/list/${encodeURIComponent(this.bucket)}`,
        {
          method: "POST",
          headers: { ...this.authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ prefix: listPrefix, limit: LIST_PAGE_SIZE, offset }),
        },
      );
      if (!res.ok) {
        throw new Error(`Supabase list failed: ${res.status} ${await safeText(res)}`);
      }
      const entries = (await res.json()) as SupabaseListEntry[];
      for (const entry of entries) {
        const isFolder = entry.id == null && entry.metadata == null;
        if (isFolder) {
          await this.listRecursive(`${listPrefix}${entry.name}/`, onFile);
        } else {
          onFile(`${listPrefix}${entry.name}`);
        }
      }
      if (entries.length < LIST_PAGE_SIZE) break;
      offset += entries.length;
    }
  }

  /** As {@link listRecursive}, but also surfaces each file's size + mtime. */
  async listRecursiveDetailed(
    listPrefix: string,
    onFile: (
      fullKey: string,
      size: number,
      updatedAt?: string | null,
    ) => void | Promise<void>,
  ): Promise<void> {
    let offset = 0;
    for (;;) {
      const res = await this.fetchImpl(
        `${this.endpoint}/object/list/${encodeURIComponent(this.bucket)}`,
        {
          method: "POST",
          headers: { ...this.authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ prefix: listPrefix, limit: LIST_PAGE_SIZE, offset }),
        },
      );
      if (!res.ok) {
        throw new Error(`Supabase list failed: ${res.status} ${await safeText(res)}`);
      }
      const entries = (await res.json()) as SupabaseListEntry[];
      for (const entry of entries) {
        const isFolder = entry.id == null && entry.metadata == null;
        if (isFolder) {
          await this.listRecursiveDetailed(`${listPrefix}${entry.name}/`, onFile);
        } else {
          await onFile(
            `${listPrefix}${entry.name}`,
            entry.metadata?.size ?? 0,
            entry.updated_at,
          );
        }
      }
      if (entries.length < LIST_PAGE_SIZE) break;
      offset += entries.length;
    }
  }
}
