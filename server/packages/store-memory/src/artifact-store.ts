import type {
  Artifact,
  ArtifactContent,
  ArtifactPutInput,
  ArtifactStore,
} from "@oma-server/store";

/**
 * In-memory {@link ArtifactStore} for dev + tests. Keyed the same way as the
 * S3 store conceptually (`<tenantId>/<workspaceId>/<path>`), but holds bytes in
 * a Map so no S3 backend is needed. Enforces the same tenant + workspace prefix
 * isolation as the real store (see ADR-0002 §4/§5).
 */
export class InMemoryArtifactStore implements ArtifactStore {
  private objects = new Map<string, { body: Uint8Array; contentType?: string; updatedAt: Date }>();
  /** Records every `list` call, so tests can assert on scoping. */
  public listCalls: Array<{ tenantId: string; workspaceId: string; prefix?: string }> = [];

  private key(tenantId: string, workspaceId: string, path: string): string {
    return `${tenantId}/${workspaceId}/${path}`;
  }

  async list(tenantId: string, workspaceId: string, prefix = ""): Promise<Artifact[]> {
    this.listCalls.push({ tenantId, workspaceId, prefix });
    const wsPrefix = `${tenantId}/${workspaceId}/`;
    const out: Artifact[] = [];
    for (const [k, v] of this.objects) {
      if (!k.startsWith(wsPrefix)) continue;
      const rel = k.slice(wsPrefix.length);
      if (prefix && !rel.startsWith(prefix)) continue;
      out.push({ path: rel, size: v.body.byteLength, updatedAt: v.updatedAt });
    }
    return out;
  }

  async get(tenantId: string, workspaceId: string, path: string): Promise<ArtifactContent | null> {
    const v = this.objects.get(this.key(tenantId, workspaceId, path));
    if (!v) return null;
    return { path, body: v.body, contentType: v.contentType };
  }

  async exists(tenantId: string, workspaceId: string, path: string): Promise<boolean> {
    return this.objects.has(this.key(tenantId, workspaceId, path));
  }

  async put(input: ArtifactPutInput): Promise<Artifact> {
    const body =
      typeof input.body === "string" ? new TextEncoder().encode(input.body) : input.body;
    this.objects.set(this.key(input.tenantId, input.workspaceId, input.path), {
      body,
      contentType: input.contentType,
      updatedAt: new Date(),
    });
    return { path: input.path, size: body.byteLength };
  }

  async delete(tenantId: string, workspaceId: string, path: string): Promise<boolean> {
    return this.objects.delete(this.key(tenantId, workspaceId, path));
  }
}
