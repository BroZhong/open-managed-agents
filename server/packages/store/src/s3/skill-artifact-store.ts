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
    const files: SkillFile[] = [];
    for (const path of paths) {
      const body = await this.get(tenantId, skillId, path);
      if (body) files.push({ path, body });
    }
    return files;
  }

  async deleteTree(tenantId: string, skillId: string): Promise<void> {
    for (const path of await this.list(tenantId, skillId)) {
      await this.client.deleteObject(this.key(tenantId, skillId, path));
    }
  }
}
