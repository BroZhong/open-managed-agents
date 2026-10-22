import { SkillNameConflictError, SkillVersionConflictError } from "../errors.js";
import { skillBundleColumns } from "../skill-bundle.js";
import { nanoid } from "nanoid";
import type { Pool } from "./connection.js";
import type {
  Skill,
  SkillOwnerType,
  SkillStore,
  SkillStoreCreateInput,
  SkillStoreListOpts,
  SkillStoreUpdateInput,
  SkillStoreUpdateOptions,
} from "../interfaces/skill-store.js";
import type { PaginatedResult } from "../types.js";

interface SkillRow {
  skill_id: string;
  tenant_id: string;
  name: string;
  description: string;
  owner_type: string;
  owner_id: string;
  source_skill_id: string | null;
  created_at: Date | null;
  updated_at: Date;
  /** Absent on a schema predating the bundle migration. */
  bundle_sha256?: string | null;
  /** BIGINT: node-postgres returns it as a string. */
  bundle_size?: string | number | null;
}

function rowToSkill(row: SkillRow): Skill {
  return {
    id: row.skill_id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description,
    ownerType: (row.owner_type as SkillOwnerType) ?? "library",
    ownerId: row.owner_id,
    sourceSkillId: row.source_skill_id ?? null,
    createdAt: row.created_at == null ? null : new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    bundleSha256: row.bundle_sha256 ?? null,
    bundleSize: row.bundle_size == null ? null : Number(row.bundle_size),
  };
}

export class PgSkillStore implements SkillStore {
  constructor(private readonly pool: Pool) {}

  async create(input: SkillStoreCreateInput): Promise<Skill> {
    const now = new Date();
    const id = `skill_${nanoid()}`;
    const ownerType: SkillOwnerType = input.ownerType ?? "library";
    // A Library Skill is owned by its tenant; a fork carries an explicit ownerId.
    const ownerId = input.ownerId ?? (ownerType === "library" ? input.tenantId : "");
    const bundle = skillBundleColumns(input);
    const { rows } = await this.pool.query<SkillRow>(
      `INSERT INTO skills (skill_id, tenant_id, name, description, owner_type, owner_id, source_skill_id, created_at, updated_at, bundle_sha256, bundle_size)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10)
       RETURNING *`,
      [id, input.tenantId, input.name, input.description, ownerType, ownerId, input.sourceSkillId ?? null, now,
        bundle?.bundleSha256 ?? null, bundle?.bundleSize ?? null],
    ).catch((error) => this.rethrowConflict(error, input.name));
    return rowToSkill(rows[0]);
  }

  async getById(id: string): Promise<Skill | null> {
    const { rows } = await this.pool.query<SkillRow>(
      `SELECT * FROM skills WHERE skill_id = $1`,
      [id],
    );
    return rows[0] ? rowToSkill(rows[0]) : null;
  }

  async list(tenantId: string, opts?: SkillStoreListOpts): Promise<PaginatedResult<Skill>> {
    const limit = opts?.limit ?? 50;
    const cursor = opts?.cursor;
    const params: unknown[] = [tenantId];
    // The Library lists only Library Skills; Agent forks are read via listByOwner.
    let where = `tenant_id = $1 AND owner_type = 'library'`;
    if (cursor) {
      params.push(cursor);
      where += ` AND skill_id > $${params.length}`;
    }
    params.push(limit + 1);
    const { rows } = await this.pool.query<SkillRow>(
      `SELECT * FROM skills WHERE ${where} ORDER BY skill_id ASC LIMIT $${params.length}`,
      params,
    );
    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map(rowToSkill);
    return { data, hasMore };
  }

  async listByOwner(
    tenantId: string,
    ownerType: SkillOwnerType,
    ownerId: string,
  ): Promise<Skill[]> {
    const { rows } = await this.pool.query<SkillRow>(
      `SELECT * FROM skills WHERE tenant_id = $1 AND owner_type = $2 AND owner_id = $3 ORDER BY skill_id ASC`,
      [tenantId, ownerType, ownerId],
    );
    return rows.map(rowToSkill);
  }

  async update(id: string, input: SkillStoreUpdateInput, options: SkillStoreUpdateOptions = {}): Promise<Skill | null> {
    const bundle = skillBundleColumns(input);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.name !== undefined) {
      params.push(input.name);
      sets.push(`name = $${params.length}`);
    }
    if (input.description !== undefined) {
      params.push(input.description);
      sets.push(`description = $${params.length}`);
    }
    if (input.sourceSkillId !== undefined) {
      params.push(input.sourceSkillId);
      sets.push(`source_skill_id = $${params.length}`);
    }
    if (bundle) {
      params.push(bundle.bundleSha256, bundle.bundleSize);
      sets.push(`bundle_sha256 = $${params.length - 1}`, `bundle_size = $${params.length}`);
    }
    params.push(new Date());
    sets.push(`updated_at = $${params.length}`);
    params.push(id);
    let where = `skill_id = $${params.length}`;
    const expected = options.expectedBundleSha256;
    if (expected === null) where += ` AND bundle_sha256 IS NULL`;
    else if (expected !== undefined) {
      params.push(expected);
      where += ` AND bundle_sha256 = $${params.length}`;
    }
    const { rows } = await this.pool.query<SkillRow>(
      `UPDATE skills SET ${sets.join(", ")} WHERE ${where} RETURNING *`,
      params,
    ).catch((error) => this.rethrowConflict(error, input.name ?? ""));
    if (rows[0]) return rowToSkill(rows[0]);
    if (expected === undefined) return null;
    // The compare-and-set matched nothing: the Skill is gone or another edit won.
    const current = await this.getById(id);
    if (!current) return null;
    throw new SkillVersionConflictError(id, expected, current.bundleSha256);
  }

  private rethrowConflict(error: { code?: string; constraint?: string }, name: string): never {
    if (error.code === "23505" && error.constraint === "skills_owner_name_unique") {
      throw new SkillNameConflictError(name);
    }
    throw error;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM skills WHERE skill_id = $1`, [id]);
    return (result.rowCount ?? 0) === 1;
  }
}
