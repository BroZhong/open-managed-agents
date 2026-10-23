import type { PaginatedResult } from "../types.js";

/**
 * A Skill's owner (ADR-0004):
 *   - `library`: a Library Skill, owned by the tenant (`ownerId === tenantId`).
 *   - `agent`: an Agent Skill / Skill Fork, owned by one Agent
 *     (`ownerId === agentId`), forked from a Library Skill.
 */
export type SkillOwnerType = "library" | "agent";

/**
 * A Skill: a reusable, instruction-only capability (a directory with a
 * `SKILL.md`). Metadata lives in this store; the files are the Skill's current
 * Skill Bundle (ADR-0022), an immutable zip that `bundleSha256` names in the
 * tenant's `SkillBundleStore`, outside every Workspace prefix.
 *
 * Per ADR-0004 every Skill has an owner. A Library Skill
 * (`ownerType='library'`) lives in the tenant's Library. Equipping it onto an
 * Agent forks it into an Agent Skill (`ownerType='agent'`, `ownerId=agentId`,
 * `sourceSkillId=<libraryId>`); the fork is independent from then on.
 * `Agent.skills` holds fork ids, never Library Skill ids.
 */
export interface Skill {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  ownerType: SkillOwnerType;
  /** Tenant id for Library Skills; Agent id for Agent Skills (forks). */
  ownerId: string;
  /** For a fork: the Library Skill id it was forked from. Null for Library Skills. */
  sourceSkillId?: string | null;
  /** Upload/fork creation time; null for legacy Skills whose creation time is unknown. */
  createdAt: Date | null;
  updatedAt: Date;
  /** sha256 of the current Skill Bundle; null until the Skill has been packed. */
  bundleSha256: string | null;
  /** Total uncompressed bytes of the current Skill Bundle; null exactly when `bundleSha256` is. */
  bundleSize: number | null;
}

/** List entry: the summary shape returned by `GET /v1/skills`. */
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  createdAt: Date | null;
  updatedAt: Date;
}

export interface SkillStoreCreateInput {
  tenantId: string;
  name: string;
  description: string;
  /** Defaults to a Library Skill owned by the tenant when omitted. */
  ownerType?: SkillOwnerType;
  ownerId?: string;
  sourceSkillId?: string | null;
  /** The Skill's first bundle; set together with `bundleSize`. Omitted = none yet. */
  bundleSha256?: string | null;
  bundleSize?: number | null;
}

export interface SkillStoreUpdateInput {
  sourceSkillId?: string | null;
  name?: string;
  description?: string;
  /** A new current bundle; set together with `bundleSize`. Omitted = unchanged. */
  bundleSha256?: string | null;
  bundleSize?: number | null;
}

export interface SkillStoreUpdateOptions {
  /**
   * Compare-and-set on the Skill's version: apply the update only if the row's
   * current `bundleSha256` is this value (null = no bundle yet); otherwise throw
   * `SkillVersionConflictError` and change nothing. Omit for an unconditional update.
   */
  expectedBundleSha256?: string | null;
}

export interface SkillStoreListOpts {
  limit?: number;
  cursor?: string;
}

export interface SkillStore {
  create(input: SkillStoreCreateInput): Promise<Skill>;
  getById(id: string): Promise<Skill | null>;
  /**
   * List the tenant's Library Skills (`ownerType='library'`). Agent Skills
   * (forks) are never returned here — an Agent's forks are read via
   * {@link listByOwner}.
   */
  list(tenantId: string, opts?: SkillStoreListOpts): Promise<PaginatedResult<Skill>>;
  /** List a specific owner's Skills, e.g. an Agent's forks (`ownerType='agent'`). */
  listByOwner(
    tenantId: string,
    ownerType: SkillOwnerType,
    ownerId: string,
  ): Promise<Skill[]>;
  /** Null when the Skill does not exist. */
  update(id: string, input: SkillStoreUpdateInput, options?: SkillStoreUpdateOptions): Promise<Skill | null>;
  delete(id: string): Promise<boolean>;
}
