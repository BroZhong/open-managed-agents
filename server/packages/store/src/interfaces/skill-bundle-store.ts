import type { PackedSkillBundle, SkillBundleEntry, SkillBundleFile } from "../skill-bundle.js";

/**
 * Content-addressed storage of immutable Skill Bundles (ADR-0022), keyed by
 * `(tenantId, sha256)`. A bundle never changes once written: an edit packs a
 * new bundle, and equip/fork reference the same sha256 without copying.
 * `skills.bundle_sha256` in PostgreSQL names each Skill's current bundle.
 *
 * Every read returns null when the tenant has no bundle with that digest.
 * Returned bytes are fresh copies the caller may keep or modify.
 */
export interface SkillBundleStore {
  /**
   * Store a packed bundle. Verifies that `sha256` is the digest of `bytes` and
   * that the bytes are a well-formed bundle. Idempotent: storing the same
   * bundle again is harmless.
   */
  put(tenantId: string, bundle: Pick<PackedSkillBundle, "sha256" | "bytes">): Promise<void>;
  /** The zip bytes. */
  get(tenantId: string, sha256: string): Promise<Uint8Array | null>;
  /** The file tree (path, uncompressed size, mode) in path order. */
  listFiles(tenantId: string, sha256: string): Promise<SkillBundleEntry[] | null>;
  /** One file's bytes; null if the bundle or the file is absent. */
  readFile(tenantId: string, sha256: string, path: string): Promise<Uint8Array | null>;
  /** Every file with bytes and mode, in path order — what an edit repacks. */
  readAll(tenantId: string, sha256: string): Promise<SkillBundleFile[] | null>;
  /**
   * A short-lived (1–900 s) GET URL a Sandbox uses to download the zip; the
   * Sandbox itself holds no storage credentials. Signing does not read the
   * object: callers sign only a bundle recorded in PostgreSQL, i.e. stored.
   */
  createInstallUrl(tenantId: string, sha256: string, expiresInSec: number): Promise<string>;
}
