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
  /** Delete every file of a Skill. */
  deleteTree(tenantId: string, skillId: string): Promise<void>;
}
