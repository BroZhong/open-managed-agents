/**
 * Supabase Storage REST primitives retained for Skill bodies and projections.
 * Workspace file operations use the independent OSS client.
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

/**
 * Supabase Storage has returned a missing object as both HTTP 404 and HTTP
 * 400 with a JSON body containing statusCode 404. Treat both forms as a
 * normal cache miss so API routes can return their documented 404 response.
 */
function isMissingObjectResponse(status: number, body: string): boolean {
  if (status === 404) return true;
  if (status !== 400) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  const record = parsed as Record<string, unknown>;
  const code = record.statusCode ?? record.status ?? record.code;
  if (String(code) === "404") return true;
  const message = [record.error, record.message]
    .filter((value) => typeof value === "string")
    .join(" ");
  return /\b(?:object|file|resource)\b[\s\S]*\bnot found\b/i.test(message);
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

  private objectUrl(key: string): string {
    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    return `${this.endpoint}/object/${encodeURIComponent(this.bucket)}/${encodedKey}`;
  }

  /** Upsert an object at an absolute (already-prefixed) key. */
  async putObject(key: string, body: Uint8Array, contentType?: string): Promise<void> {
    const res = await this.fetchImpl(this.objectUrl(key), {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        "Content-Type": contentType ?? "application/octet-stream",
        "x-upsert": "true",
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
    if (!res.ok) {
      const body = await safeText(res);
      if (isMissingObjectResponse(res.status, body)) return null;
      throw new Error(`Supabase getObject failed: ${res.status} ${body}`);
    }
    return {
      body: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") ?? undefined,
    };
  }

  /** Delete an object. Returns true if it existed. */
  async deleteObject(key: string): Promise<boolean> {
    const res = await this.fetchImpl(this.objectUrl(key), {
      method: "DELETE",
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      const body = await safeText(res);
      if (isMissingObjectResponse(res.status, body)) return false;
      throw new Error(`Supabase deleteObject failed: ${res.status} ${body}`);
    }
    return true;
  }

  /**
   * Recursively list files under `listPrefix` (Supabase's list is not
   * recursive), invoking `onFile(fullKey)` for each concrete file.
   */
  async listRecursive(listPrefix: string, onFile: (fullKey: string) => void): Promise<void> {
    let offset = 0;
    for (;;) {
      const res = await this.fetchImpl(`${this.endpoint}/object/list/${encodeURIComponent(this.bucket)}`, {
        method: "POST",
        headers: { ...this.authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ prefix: listPrefix, limit: LIST_PAGE_SIZE, offset }),
      });
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

}
