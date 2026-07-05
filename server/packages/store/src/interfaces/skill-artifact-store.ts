/**
 * A single Skill file body stored under a Skill's S3 namespace.
 *
 * `path` is the Skill-relative path (never includes the tenant/skill prefix —
 * that is an implementation detail of the store's key layout).
 */
export interface SkillFile {
  path: string;
  body: Uint8Array;
}

/**
 * Storage for Skill file bodies, keyed by `<tenantId>/skills/<skillId>/<path>`.
 *
 * This is a DISTINCT namespace from Workspace artifacts (`<tenantId>/<wsId>/…`):
 * a Skill's files can never collide with or leak into a Session's Workspace.
 * See ADR-0002 §4/§5.
 */
export interface SkillArtifactStore {
  /** Write (create or overwrite) one file under a Skill's namespace. */
  put(tenantId: string, skillId: string, path: string, body: Uint8Array | string): Promise<void>;
  /** List a Skill's file paths (relative). */
  list(tenantId: string, skillId: string): Promise<string[]>;
  /** Fetch one file's bytes, or null if absent. */
  get(tenantId: string, skillId: string, path: string): Promise<Uint8Array | null>;
  /** Read every file of a Skill (path + bytes) — used to materialize to disk. */
  getAll(tenantId: string, skillId: string): Promise<SkillFile[]>;
  /** Delete one file under a Skill's namespace. No-op if absent. */
  delete(tenantId: string, skillId: string, path: string): Promise<void>;
  /**
   * Rename/move one file within a Skill's directory (copy to `toPath`, delete
   * `fromPath`). No-op if `fromPath` is absent.
   */
  move(tenantId: string, skillId: string, fromPath: string, toPath: string): Promise<void>;
  /** Delete every file of a Skill. */
  deleteTree(tenantId: string, skillId: string): Promise<void>;
  /**
   * Copy every file of `fromSkillId` into `toSkillId` (same tenant) — the
   * file-level half of forking a Skill on equip (ADR-0004). Overwrites any
   * existing files at the destination paths.
   */
  copyTree(tenantId: string, fromSkillId: string, toSkillId: string): Promise<void>;
}
