import type {
  SkillArtifactStore,
  SkillFile,
} from "../interfaces/skill-artifact-store.js";
import {
  SupabaseStorageClient,
  normalizePath,
  toBytes,
  type SupabaseStorageOptions,
} from "./supabase-storage.js";

export type S3SkillArtifactStoreOptions = SupabaseStorageOptions;

const SKILL_IO_CONCURRENCY = 8;

async function mapInBatches<T, R>(
  items: T[],
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let offset = 0; offset < items.length; offset += SKILL_IO_CONCURRENCY) {
    const batch = await Promise.allSettled(
      items.slice(offset, offset + SKILL_IO_CONCURRENCY).map(operation),
    );
    for (const result of batch) {
      if (result.status === "rejected") throw result.reason;
      results.push(result.value);
    }
  }
  return results;
}

/**
 * S3 store for Skill file bodies, backed by Supabase Storage.
 *
 * Keys are `<tenantId>/skills/<skillId>/<path>` — a distinct namespace from
 * Workspace artifacts (`<tenantId>/<workspaceId>/…`), so a Skill's files can
 * never collide with or leak into a Session's Workspace. Cross-tenant /
 * cross-skill isolation is enforced entirely by this key prefix. Shares the
 * Supabase wire logic with {@link S3ArtifactStore} via {@link SupabaseStorageClient}.
 */
export class S3SkillArtifactStore implements SkillArtifactStore {
  private readonly client: SupabaseStorageClient;

  constructor(opts: S3SkillArtifactStoreOptions) {
    this.client = new SupabaseStorageClient(opts, "S3SkillArtifactStore");
  }

  /** `<tenantId>/skills/<skillId>` — the isolation boundary for a Skill. */
  private prefix(tenantId: string, skillId: string): string {
    return `${encodeURIComponent(tenantId)}/skills/${encodeURIComponent(skillId)}`;
  }

  private key(tenantId: string, skillId: string, path: string): string {
    return `${this.prefix(tenantId, skillId)}/${normalizePath(path, "skill")}`;
  }

  async put(tenantId: string, skillId: string, path: string, body: Uint8Array | string): Promise<void> {
    await this.client.putObject(this.key(tenantId, skillId, path), toBytes(body));
  }

  async list(tenantId: string, skillId: string): Promise<string[]> {
    const base = this.prefix(tenantId, skillId);
    const paths: string[] = [];
    await this.client.listRecursive(`${base}/`, (fullKey) => paths.push(fullKey.slice(base.length + 1)));
    return paths;
  }

  async get(tenantId: string, skillId: string, path: string): Promise<Uint8Array | null> {
    const obj = await this.client.getObject(this.key(tenantId, skillId, path));
    return obj ? obj.body : null;
  }

  async getAll(tenantId: string, skillId: string): Promise<SkillFile[]> {
    const paths = await this.list(tenantId, skillId);
    const files = await mapInBatches(paths, async (path) => {
      const body = await this.get(tenantId, skillId, path);
      return body ? { path, body } : null;
    });
    return files.filter((file): file is SkillFile => file !== null);
  }

  async delete(tenantId: string, skillId: string, path: string): Promise<void> {
    await this.client.deleteObject(this.key(tenantId, skillId, path));
  }

  async move(tenantId: string, skillId: string, fromPath: string, toPath: string): Promise<void> {
    const body = await this.get(tenantId, skillId, fromPath);
    if (!body) return;
    await this.put(tenantId, skillId, toPath, body);
    await this.delete(tenantId, skillId, fromPath);
  }

  async deleteTree(tenantId: string, skillId: string): Promise<void> {
    await mapInBatches(await this.list(tenantId, skillId), async (path) => {
      await this.client.deleteObject(this.key(tenantId, skillId, path));
    });
  }

  async copyTree(tenantId: string, fromSkillId: string, toSkillId: string): Promise<void> {
    await mapInBatches(await this.getAll(tenantId, fromSkillId), async (file) => {
      await this.put(tenantId, toSkillId, file.path, file.body);
    });
  }
}
