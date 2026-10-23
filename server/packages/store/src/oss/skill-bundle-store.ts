import OSS from "ali-oss";
import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";
import { InvalidSkillBundleError } from "../errors.js";
import type { SkillBundleStore } from "../interfaces/skill-bundle-store.js";
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
} from "../skill-bundle.js";
import { isMissingObject, type OSSArtifactStoreOptions, type OSSObjectClient } from "./artifact-store.js";

export interface OSSSkillBundleStoreOptions extends OSSArtifactStoreOptions {
  /**
   * The endpoint install URLs are signed for, reachable from Sandboxes inside
   * the VPC. Must be the region's internal endpoint, which is the default:
   * `https://<region>-internal.aliyuncs.com`.
   */
  internalEndpoint?: string;
  /** Bytes of immutable bundles cached in process. Default 64 MiB; 0 disables. */
  cacheBytes?: number;
}

const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024;

/** `__oma/skills/<tenantId>/<sha256>.zip`: Host-only, outside every mounted Workspace prefix. */
export function skillBundleObjectKey(tenantId: string, sha256: string): string {
  assertSkillBundleIdentity(tenantId, sha256);
  return `__oma/skills/${tenantId}/${sha256}.zip`;
}

/** Skill Bundles in the Workspace OSS Bucket (ADR-0022). */
export class OSSSkillBundleStore implements SkillBundleStore {
  private readonly client: Pick<OSSObjectClient, "put" | "get">;
  private readonly signer: OSS;
  private readonly cache?: LRUCache<string, Uint8Array>;

  constructor(options: OSSSkillBundleStoreOptions) {
    const { client, publicEndpoint: _publicEndpoint, internalEndpoint, cacheBytes = DEFAULT_CACHE_BYTES, ...sdkOptions } = options;
    if (!/^oss-[a-z0-9-]+$/.test(options.region) || options.region.includes("-internal")) {
      throw new Error("Invalid OSS region");
    }
    const expected = `https://${options.region}-internal.aliyuncs.com`;
    let endpoint: URL | undefined;
    try { endpoint = new URL(internalEndpoint ?? expected); } catch { /* rejected below */ }
    if (endpoint?.href !== `${expected}/`) {
      throw new Error("Skill Bundle install URLs must use the region's internal OSS endpoint");
    }
    if (!Number.isSafeInteger(cacheBytes) || cacheBytes < 0) throw new Error("Invalid Skill Bundle cache size");
    this.client = client ?? new OSS({ ...sdkOptions, secure: true, authorizationV4: true });
    this.signer = new OSS({ ...sdkOptions, endpoint: expected, secure: true, authorizationV4: true });
    // Bundles are immutable, so a cached copy never goes stale. Concurrent
    // misses for one bundle share a single download; misses are not cached.
    if (cacheBytes > 0) {
      this.cache = new LRUCache<string, Uint8Array>({
        maxSize: cacheBytes,
        sizeCalculation: (bytes) => Math.max(1, bytes.byteLength),
        fetchMethod: (key) => this.download(key),
      });
    }
  }

  private async download(key: string): Promise<Uint8Array | undefined> {
    let content: Buffer | undefined;
    try {
      content = (await this.client.get(key)).content;
    } catch (error) {
      if (isMissingObject(error)) return undefined;
      throw error;
    }
    if (!content) throw new Error("OSS returned no object body");
    const bytes = new Uint8Array(content);
    if (!key.endsWith(`/${createHash("sha256").update(bytes).digest("hex")}.zip`)) {
      throw new InvalidSkillBundleError("Stored Skill Bundle does not match its sha256");
    }
    return bytes;
  }

  /** Shared cached bytes: never hand these to a caller without copying or parsing. */
  private async bytes(tenantId: string, sha256: string): Promise<Uint8Array | null> {
    const key = skillBundleObjectKey(tenantId, sha256);
    return (this.cache ? await this.cache.fetch(key) : await this.download(key)) ?? null;
  }

  async put(tenantId: string, bundle: Pick<PackedSkillBundle, "sha256" | "bytes">): Promise<void> {
    const key = skillBundleObjectKey(tenantId, bundle.sha256);
    const bytes = bundle.bytes.slice();
    await verifySkillBundle({ sha256: bundle.sha256, bytes });
    // Content-addressed: rewriting an existing key writes identical bytes.
    await this.client.put(key, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { mime: "application/zip" });
    this.cache?.set(key, bytes);
  }

  async get(tenantId: string, sha256: string): Promise<Uint8Array | null> {
    return (await this.bytes(tenantId, sha256))?.slice() ?? null;
  }

  async listFiles(tenantId: string, sha256: string): Promise<SkillBundleEntry[] | null> {
    const bytes = await this.bytes(tenantId, sha256);
    return bytes && listSkillBundle(bytes);
  }

  async readFile(tenantId: string, sha256: string, path: string): Promise<Uint8Array | null> {
    const bytes = await this.bytes(tenantId, sha256);
    return bytes && readSkillBundleFile(bytes, path);
  }

  async readAll(tenantId: string, sha256: string): Promise<SkillBundleFile[] | null> {
    const bytes = await this.bytes(tenantId, sha256);
    return bytes && unpackSkillBundle(bytes);
  }

  async createInstallUrl(tenantId: string, sha256: string, expiresInSec: number): Promise<string> {
    const key = skillBundleObjectKey(tenantId, sha256);
    assertInstallUrlExpiry(expiresInSec);
    return this.signer.signatureUrlV4("GET", expiresInSec, undefined, key);
  }
}
