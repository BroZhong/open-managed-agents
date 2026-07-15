import type {
  Artifact,
  ArtifactContent,
  ArtifactPutInput,
  ArtifactStore,
} from "../interfaces/artifact-store.js";
import {
  SupabaseStorageClient,
  normalizePath,
  toBytes,
  type SupabaseStorageOptions,
} from "./supabase-storage.js";
import {
  classifyStoragePath,
  isStoragePathCodecCandidate,
  STORAGE_PATH_CODEC_METADATA,
  storagePathCandidates,
} from "./storage-path-codec.js";

interface PhysicalKeyCandidate {
  key: string;
  storagePath: string;
}

interface PhysicalKeyCandidates {
  canonical: PhysicalKeyCandidate;
  legacy?: PhysicalKeyCandidate;
}

interface PhysicalKeyResolution {
  existingKey: string | null;
  writeTarget: { key: string; encoded: boolean } | null;
}

export interface S3ArtifactStoreOptions extends SupabaseStorageOptions {
  /**
   * Publicly-reachable Storage base (the instance's `public_url` + `/storage/v1`,
   * e.g. `http://47.252.145.10:80/storage/v1`), onto which a relative signedURL
   * is prefixed to form an absolute, browser-reachable GET URL. The client signs
   * on the internal `endpoint`; this base is where the browser downloads. Absent
   * → `createSignedReadUrl` is unavailable (signing without a reachable base is
   * useless). Wired from `STORAGE_PUBLIC_BASE`. See ADR-0006 §1, research #88 §3/§5.
   */
  publicBase?: string;
}

/**
 * S3-authoritative artifact storage backed by Supabase Storage.
 *
 * Every key is prefixed `<tenantId>/<workspaceId>/<path>`, which is the only
 * mechanism enforcing cross-tenant / cross-workspace isolation: a caller
 * scoped to (tenant, workspace) can neither list, read, write, nor delete
 * outside its own prefix. See ADR-0002 §4/§5. Shares the Supabase wire logic
 * with the Skill artifact store via {@link SupabaseStorageClient}.
 */
export class S3ArtifactStore implements ArtifactStore {
  private readonly client: SupabaseStorageClient;
  private readonly publicBase?: string;

  constructor(opts: S3ArtifactStoreOptions) {
    this.client = new SupabaseStorageClient(opts, "S3ArtifactStore");
    this.publicBase = opts.publicBase?.replace(/\/+$/, "") || undefined;
  }

  /** `<tenantId>/<workspaceId>` — the isolation boundary for a workspace. */
  private workspacePrefix(tenantId: string, workspaceId: string): string {
    return `${encodeURIComponent(tenantId)}/${encodeURIComponent(workspaceId)}`;
  }

  /** Named physical keys for the codec representation and legacy raw fallback. */
  private keys(
    tenantId: string,
    workspaceId: string,
    path: string,
  ): PhysicalKeyCandidates {
    const prefix = this.workspacePrefix(tenantId, workspaceId);
    const normalized = normalizePath(path);
    const paths = storagePathCandidates(normalized);
    return {
      canonical: {
        key: `${prefix}/${paths.canonical}`,
        storagePath: paths.canonical,
      },
      ...(paths.legacy
        ? {
            legacy: {
              key: `${prefix}/${paths.legacy}`,
              storagePath: paths.legacy,
            },
          }
        : {}),
    };
  }

  /**
   * Resolve one logical path to the physical key already in use. A legacy raw
   * key remains writable in place; a new path uses the canonical codec key.
   * Seeing both is ambiguous and must not be hidden by silently choosing one.
   */
  private async resolvePhysicalKey(
    tenantId: string,
    workspaceId: string,
    path: string,
  ): Promise<PhysicalKeyResolution> {
    const normalized = normalizePath(path);
    const candidates = this.keys(tenantId, workspaceId, normalized);
    if (!candidates.legacy) {
      return {
        existingKey: (await this.client.objectExists(candidates.canonical.key))
          ? candidates.canonical.key
          : null,
        writeTarget: { key: candidates.canonical.key, encoded: false },
      };
    }

    const [canonicalInfo, legacyInfo] = await Promise.all([
      this.client.getObjectInfo(candidates.canonical.key),
      this.client.getObjectInfo(candidates.legacy.key, { invalidKeyAsMissing: true }),
    ]);
    const occupied = [
      canonicalInfo
        ? {
            candidate: candidates.canonical,
            classification: classifyStoragePath(
              candidates.canonical.storagePath,
              canonicalInfo.userMetadata,
            ),
          }
        : null,
      legacyInfo
        ? {
            candidate: candidates.legacy,
            classification: classifyStoragePath(
              candidates.legacy.storagePath,
              legacyInfo.userMetadata,
            ),
          }
        : null,
    ].filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    const matching = occupied.filter(
      ({ classification }) => classification.logicalPath === normalized,
    );
    if (matching.length > 1) {
      throw new Error(
        `S3ArtifactStore: conflicting physical keys for logical path ${normalized}`,
      );
    }

    const existing = matching[0];
    if (existing) {
      return {
        existingKey: existing.candidate.key,
        writeTarget: {
          key: existing.candidate.key,
          encoded: existing.classification.encoded,
        },
      };
    }

    // An unmarked legacy filename can legitimately equal this path's encoded
    // key. It belongs to a different logical file, so reads see "missing" and
    // writes must fail instead of overwriting it.
    return {
      existingKey: null,
      writeTarget: canonicalInfo
        ? null
        : { key: candidates.canonical.key, encoded: true },
    };
  }

  private requireWriteTarget(
    path: string,
    resolution: PhysicalKeyResolution,
  ): { key: string; encoded: boolean } {
    if (resolution.writeTarget) return resolution.writeTarget;
    throw new Error(
      `S3ArtifactStore: encoded physical key is occupied by another logical path: ${normalizePath(path)}`,
    );
  }

  private async readKeyFor(
    tenantId: string,
    workspaceId: string,
    path: string,
  ): Promise<string | null> {
    const candidates = this.keys(tenantId, workspaceId, path);
    return candidates.legacy
      ? (await this.resolvePhysicalKey(tenantId, workspaceId, path)).existingKey
      : candidates.canonical.key;
  }

  private async writeTargetFor(
    tenantId: string,
    workspaceId: string,
    path: string,
  ): Promise<{ key: string; encoded: boolean }> {
    const candidates = this.keys(tenantId, workspaceId, path);
    return candidates.legacy
      ? this.requireWriteTarget(
          path,
          await this.resolvePhysicalKey(tenantId, workspaceId, path),
        )
      : { key: candidates.canonical.key, encoded: false };
  }

  async list(tenantId: string, workspaceId: string, prefix = ""): Promise<Artifact[]> {
    const wsPrefix = this.workspacePrefix(tenantId, workspaceId);
    const relPrefix = prefix ? normalizePath(prefix) : "";
    // A prefix may stop in the middle of a segment. List from its nearest full
    // directory ancestor, then apply the exact logical prefix after decoding.
    const lastSlash = relPrefix.lastIndexOf("/");
    const ancestor = lastSlash >= 0 ? relPrefix.slice(0, lastSlash + 1) : "";
    const prefixCandidates = storagePathCandidates(ancestor);
    const listPrefixes = new Set([
      prefixCandidates.canonical,
      ...(prefixCandidates.legacy ? [prefixCandidates.legacy] : []),
    ]);

    const results = new Map<string, { artifact: Artifact; physicalKey: string }>();
    const seenPhysicalKeys = new Set<string>();
    const listed: Array<{ fullKey: string; size: number; updatedAt?: string | null }> = [];
    for (const storagePrefix of listPrefixes) {
      const listPrefix = storagePrefix
        ? `${wsPrefix}/${storagePrefix}`
        : `${wsPrefix}/`;
      await this.client.listRecursiveDetailed(listPrefix, (fullKey, size, updatedAt) => {
        if (seenPhysicalKeys.has(fullKey)) return;
        seenPhysicalKeys.add(fullKey);
        listed.push({ fullKey, size, updatedAt });
      });
    }

    // Supabase's list response omits user_metadata. Only marker-shaped keys
    // need an info lookup; bound concurrency so a large Unicode workspace does
    // not create an unbounded request burst.
    const INFO_CONCURRENCY = 16;
    for (let offset = 0; offset < listed.length; offset += INFO_CONCURRENCY) {
      await Promise.all(
        listed.slice(offset, offset + INFO_CONCURRENCY).map(async (entry) => {
          const physicalPath = entry.fullKey.slice(wsPrefix.length + 1);
          const needsCodecInfo = isStoragePathCodecCandidate(physicalPath);
          const info = needsCodecInfo
            ? await this.client.getObjectInfo(entry.fullKey)
            : null;
          // The object may disappear between list and info during a concurrent
          // delete. Skip that stale list entry rather than inventing a filename.
          if (needsCodecInfo && !info) return;
          const { logicalPath } = classifyStoragePath(
            physicalPath,
            info?.userMetadata,
          );
          if (relPrefix && !logicalPath.startsWith(relPrefix)) return;

          const existing = results.get(logicalPath);
          if (existing && existing.physicalKey !== entry.fullKey) {
            throw new Error(
              `S3ArtifactStore: conflicting physical keys for logical path ${logicalPath}`,
            );
          }
          results.set(logicalPath, {
            physicalKey: entry.fullKey,
            artifact: {
              path: logicalPath,
              size: entry.size,
              updatedAt: entry.updatedAt ? new Date(entry.updatedAt) : undefined,
            },
          });
        }),
      );
    }
    return [...results.values()].map(({ artifact }) => artifact);
  }

  async get(
    tenantId: string,
    workspaceId: string,
    path: string,
  ): Promise<ArtifactContent | null> {
    const normalized = normalizePath(path);
    const key = await this.readKeyFor(tenantId, workspaceId, normalized);
    if (!key) return null;
    const obj = await this.client.getObject(key);
    return obj
      ? { path: normalized, body: obj.body, contentType: obj.contentType }
      : null;
  }

  async exists(tenantId: string, workspaceId: string, path: string): Promise<boolean> {
    return (await this.resolvePhysicalKey(tenantId, workspaceId, path)).existingKey !== null;
  }

  async put(input: ArtifactPutInput): Promise<Artifact> {
    const body = toBytes(input.body);
    const path = normalizePath(input.path);
    const target = await this.writeTargetFor(input.tenantId, input.workspaceId, path);
    await this.client.putObject(
      target.key,
      body,
      input.contentType,
      target.encoded ? STORAGE_PATH_CODEC_METADATA : undefined,
    );
    return { path, size: body.byteLength };
  }

  async delete(tenantId: string, workspaceId: string, path: string): Promise<boolean> {
    const key = await this.readKeyFor(tenantId, workspaceId, path);
    return key ? this.client.deleteObject(key) : false;
  }

  /**
   * Sign a short-lived, read-only GET URL for `<tenantId>/<workspaceId>/<path>`.
   * The client signs on the internal endpoint (bucket stays private); we then
   * prefix the relative signedURL with the configured public base to form an
   * absolute, browser-reachable URL. Read-only — never signs writes (ADR-0006 §1/§2).
   * Throws if no public base is configured (signing without a reachable base is
   * useless — the caller should treat this as "presigned reads not available").
   */
  async createSignedReadUrl(
    tenantId: string,
    workspaceId: string,
    path: string,
    expiresInSec: number,
  ): Promise<string> {
    if (!this.publicBase) {
      throw new Error(
        "S3ArtifactStore: publicBase not configured (set STORAGE_PUBLIC_BASE) — cannot sign a reachable URL",
      );
    }
    const key = (await this.writeTargetFor(tenantId, workspaceId, path)).key;
    const signedURL = await this.client.createSignedUrl(key, expiresInSec);
    return this.publicBase + signedURL;
  }
}
