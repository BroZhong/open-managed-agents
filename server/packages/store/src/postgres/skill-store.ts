import { nanoid } from "nanoid";
import type { Pool } from "./connection.js";
import type {
  Skill,
  SkillOwnerType,
  SkillStore,
  SkillStoreCreateInput,
  SkillStoreListOpts,
  SkillStoreUpdateInput,
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
  updated_at: Date;
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
    updatedAt: new Date(row.updated_at),
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
    const { rows } = await this.pool.query<SkillRow>(
      `INSERT INTO skills (skill_id, tenant_id, name, description, owner_type, owner_id, source_skill_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [id, input.tenantId, input.name, input.description, ownerType, ownerId, input.sourceSkillId ?? null, now],
    );
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

  async update(id: string, input: SkillStoreUpdateInput): Promise<Skill | null> {
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
    params.push(new Date());
    sets.push(`updated_at = $${params.length}`);
    params.push(id);
    const { rows } = await this.pool.query<SkillRow>(
      `UPDATE skills SET ${sets.join(", ")} WHERE skill_id = $${params.length} RETURNING *`,
      params,
    );
    return rows[0] ? rowToSkill(rows[0]) : null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM skills WHERE skill_id = $1`, [id]);
    return (result.rowCount ?? 0) === 1;
  }
}
