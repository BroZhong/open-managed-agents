import type { PaginatedResult } from "../types.js";

/**
 * A Skill in the tenant-scoped Library: a reusable, instruction-only capability
 * (a directory with a `SKILL.md`). Metadata lives in this store; the file
 * bodies live in S3 under `<tenantId>/skills/<skillId>/…` (a distinct namespace
 * from Workspace artifacts). Skills are equipped onto Agents by reference
 * (Agent.skills holds skillIds); there is no join table.
 */
export interface Skill {
  id: string;
  tenantId: string;
  name: string;
  description: string;
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
  list(tenantId: string, opts?: SkillStoreListOpts): Promise<PaginatedResult<Skill>>;
  update(id: string, input: SkillStoreUpdateInput): Promise<Skill | null>;
  delete(id: string): Promise<boolean>;
}
