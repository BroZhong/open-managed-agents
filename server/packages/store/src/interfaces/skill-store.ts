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
 * `SKILL.md`). Metadata lives in this store; the file bodies live in S3 under
 * `<tenantId>/skills/<skillId>/…` (a distinct namespace from Workspace
 * artifacts).
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
  updatedAt: Date;
}

/** List entry: the summary shape returned by `GET /v1/skills`. */
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
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
}

export interface SkillStoreUpdateInput {
  name?: string;
  description?: string;
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
  update(id: string, input: SkillStoreUpdateInput): Promise<Skill | null>;
  delete(id: string): Promise<boolean>;
}
