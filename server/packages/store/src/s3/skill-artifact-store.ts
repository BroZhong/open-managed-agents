import type {
  SkillArtifactStore,
  SkillFile,
} from "../interfaces/skill-artifact-store.js";

export interface S3SkillArtifactStoreOptions {
  /** Supabase Storage REST base, e.g. `http://host:80/storage/v1`. */
  endpoint: string;
  /** service_role JWT used as `Authorization: Bearer <serviceKey>`. */
  serviceKey: string;
  /** Storage bucket. Defaults to `workspace` (Skills live under a `skills/` key prefix). */
  bucket?: string;
  /** Injectable fetch (defaults to global fetch) — the seam mocked in tests. */
  fetch?: typeof fetch;
}

interface SupabaseListEntry {
  name: string;
  id?: string | null;
  updated_at?: string | null;
  metadata?: { size?: number; mimetype?: string } | null;
}

const DEFAULT_BUCKET = "workspace";
const LIST_PAGE_SIZE = 1000;

function normalizePath(path: string): string {
  const trimmed = path.replace(/^\/+/, "");
  const segments = trimmed.split("/");
  if (segments.some((s) => s === "." || s === "..")) {
    throw new Error(`Invalid skill path: ${path}`);
  }
  return trimmed;
}

function toBytes(body: Uint8Array | string): Uint8Array {
  return typeof body === "string" ? new TextEncoder().encode(body) : body;
}

/**
 * S3 store for Skill file bodies, backed by Supabase Storage.
 *
 * Keys are `<tenantId>/skills/<skillId>/<path>` — a distinct namespace from
 * Workspace artifacts (`<tenantId>/<workspaceId>/…`), so a Skill's files can
 * never collide with or leak into a Session's Workspace. Cross-tenant /
 * cross-skill isolation is enforced entirely by this key prefix.
 */
export class S3SkillArtifactStore implements SkillArtifactStore {
  private readonly endpoint: string;
  private readonly serviceKey: string;
  private readonly bucket: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: S3SkillArtifactStoreOptions) {
    if (!opts.endpoint) throw new Error("S3SkillArtifactStore: endpoint is required");
    if (!opts.serviceKey) throw new Error("S3SkillArtifactStore: serviceKey is required");
    this.endpoint = opts.endpoint.replace(/\/+$/, "");
    this.serviceKey = opts.serviceKey;
    this.bucket = opts.bucket ?? DEFAULT_BUCKET;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** `<tenantId>/skills/<skillId>` — the isolation boundary for a Skill. */
  private skillPrefix(tenantId: string, skillId: string): string {
    return `${encodeURIComponent(tenantId)}/skills/${encodeURIComponent(skillId)}`;
  }

  private key(tenantId: string, skillId: string, path: string): string {
    return `${this.skillPrefix(tenantId, skillId)}/${normalizePath(path)}`;
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.serviceKey}` };
  }

  private objectUrl(key: string): string {
    return `${this.endpoint}/object/${this.bucket}/${key}`;
  }

  async put(tenantId: string, skillId: string, path: string, body: Uint8Array | string): Promise<void> {
    const key = this.key(tenantId, skillId, path);
    const bytes = toBytes(body);
    const res = await this.fetchImpl(this.objectUrl(key), {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        "Content-Type": "application/octet-stream",
        "x-upsert": "true",
      },
      body: bytes as unknown as BodyInit,
    });
    if (!res.ok) {
      throw new Error(`S3SkillArtifactStore.put failed: ${res.status} ${await safeText(res)}`);
    }
  }

  async list(tenantId: string, skillId: string): Promise<string[]> {
    const prefix = this.skillPrefix(tenantId, skillId);
    const paths: string[] = [];
    await this.listRecursive(prefix, `${prefix}/`, paths);
    return paths;
  }

  private async listRecursive(basePrefix: string, listPrefix: string, out: string[]): Promise<void> {
    let offset = 0;
    for (;;) {
      const res = await this.fetchImpl(`${this.endpoint}/object/list/${this.bucket}`, {
        method: "POST",
        headers: { ...this.authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ prefix: listPrefix, limit: LIST_PAGE_SIZE, offset }),
      });
      if (!res.ok) {
        throw new Error(`S3SkillArtifactStore.list failed: ${res.status} ${await safeText(res)}`);
      }
      const entries = (await res.json()) as SupabaseListEntry[];
      for (const entry of entries) {
        const isFolder = entry.id == null && entry.metadata == null;
        if (isFolder) {
          await this.listRecursive(basePrefix, `${listPrefix}${entry.name}/`, out);
          continue;
        }
        const fullKey = `${listPrefix}${entry.name}`;
        out.push(fullKey.slice(basePrefix.length + 1));
      }
      if (entries.length < LIST_PAGE_SIZE) break;
      offset += entries.length;
    }
  }

  async get(tenantId: string, skillId: string, path: string): Promise<Uint8Array | null> {
    const key = this.key(tenantId, skillId, path);
    const res = await this.fetchImpl(this.objectUrl(key), {
      method: "GET",
      headers: this.authHeaders(),
    });
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok) {
      throw new Error(`S3SkillArtifactStore.get failed: ${res.status} ${await safeText(res)}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  async getAll(tenantId: string, skillId: string): Promise<SkillFile[]> {
    const paths = await this.list(tenantId, skillId);
    const files: SkillFile[] = [];
    for (const path of paths) {
      const body = await this.get(tenantId, skillId, path);
      if (body) files.push({ path, body });
    }
    return files;
  }

  async deleteTree(tenantId: string, skillId: string): Promise<void> {
    const paths = await this.list(tenantId, skillId);
    for (const path of paths) {
      const key = this.key(tenantId, skillId, path);
      const res = await this.fetchImpl(this.objectUrl(key), {
        method: "DELETE",
        headers: this.authHeaders(),
      });
      if (!res.ok && res.status !== 404 && res.status !== 400) {
        throw new Error(`S3SkillArtifactStore.deleteTree failed: ${res.status} ${await safeText(res)}`);
      }
    }
  }
}

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
