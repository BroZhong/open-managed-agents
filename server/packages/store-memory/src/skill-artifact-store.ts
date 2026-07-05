import type { SkillArtifactStore, SkillFile } from "@oma-server/store";

/**
 * In-memory {@link SkillArtifactStore} for dev + tests. Keyed the same way as
 * the S3 store conceptually (`<tenantId>/skills/<skillId>/<path>`), but holds
 * bytes in a Map so no S3 backend is needed.
 */
export class InMemorySkillArtifactStore implements SkillArtifactStore {
  private files = new Map<string, Uint8Array>();

  private prefix(tenantId: string, skillId: string): string {
    return `${tenantId}/skills/${skillId}/`;
  }

  async put(tenantId: string, skillId: string, path: string, body: Uint8Array | string): Promise<void> {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    this.files.set(`${this.prefix(tenantId, skillId)}${path}`, bytes);
  }

  async list(tenantId: string, skillId: string): Promise<string[]> {
    const p = this.prefix(tenantId, skillId);
    return [...this.files.keys()].filter((k) => k.startsWith(p)).map((k) => k.slice(p.length));
  }

  async get(tenantId: string, skillId: string, path: string): Promise<Uint8Array | null> {
    return this.files.get(`${this.prefix(tenantId, skillId)}${path}`) ?? null;
  }

  async getAll(tenantId: string, skillId: string): Promise<SkillFile[]> {
    const p = this.prefix(tenantId, skillId);
    return [...this.files.entries()]
      .filter(([k]) => k.startsWith(p))
      .map(([k, body]) => ({ path: k.slice(p.length), body }));
  }

  async deleteTree(tenantId: string, skillId: string): Promise<void> {
    const p = this.prefix(tenantId, skillId);
    for (const k of [...this.files.keys()]) {
      if (k.startsWith(p)) this.files.delete(k);
    }
  }
}
