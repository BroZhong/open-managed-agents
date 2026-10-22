import {
  assertInstallUrlExpiry,
  assertSkillBundleIdentity,
  listSkillBundle,
  readSkillBundleFile,
  unpackSkillBundle,
  verifySkillBundle,
  type PackedSkillBundle,
  type SkillBundleEntry,
  type SkillBundleFile,
  type SkillBundleStore,
} from "@oma-server/store";

/**
 * In-memory {@link SkillBundleStore} for dev + tests. Install URLs are `data:`
 * URLs carrying the zip, so `fetch()` downloads them like a signed OSS URL;
 * unlike OSS signing, an absent bundle cannot be signed.
 */
export class InMemorySkillBundleStore implements SkillBundleStore {
  private readonly bundles = new Map<string, Uint8Array>();

  private key(tenantId: string, sha256: string): string {
    assertSkillBundleIdentity(tenantId, sha256);
    return `${tenantId}/${sha256}`;
  }

  private bytes(tenantId: string, sha256: string): Uint8Array | null {
    return this.bundles.get(this.key(tenantId, sha256)) ?? null;
  }

  async put(tenantId: string, bundle: Pick<PackedSkillBundle, "sha256" | "bytes">): Promise<void> {
    const key = this.key(tenantId, bundle.sha256);
    const bytes = bundle.bytes.slice();
    await verifySkillBundle({ sha256: bundle.sha256, bytes });
    this.bundles.set(key, bytes);
  }

  async get(tenantId: string, sha256: string): Promise<Uint8Array | null> {
    return this.bytes(tenantId, sha256)?.slice() ?? null;
  }

  async listFiles(tenantId: string, sha256: string): Promise<SkillBundleEntry[] | null> {
    const bytes = this.bytes(tenantId, sha256);
    return bytes && listSkillBundle(bytes);
  }

  async readFile(tenantId: string, sha256: string, path: string): Promise<Uint8Array | null> {
    const bytes = this.bytes(tenantId, sha256);
    return bytes && readSkillBundleFile(bytes, path);
  }

  async readAll(tenantId: string, sha256: string): Promise<SkillBundleFile[] | null> {
    const bytes = this.bytes(tenantId, sha256);
    return bytes && unpackSkillBundle(bytes);
  }

  async createInstallUrl(tenantId: string, sha256: string, expiresInSec: number): Promise<string> {
    const bytes = this.bytes(tenantId, sha256);
    assertInstallUrlExpiry(expiresInSec);
    if (!bytes) throw new Error("Skill Bundle not found");
    return `data:application/zip;base64,${Buffer.from(bytes).toString("base64")}`;
  }
}
