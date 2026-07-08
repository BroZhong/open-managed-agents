import { nanoid } from "nanoid";
import type { Pool } from "./connection.js";
import type {
  WorkspaceMetadataStore,
  WorkspaceMetadataStoreCreateInput,
  WorkspaceMetadataStoreUpdateInput,
} from "../interfaces/workspace-metadata-store.js";
import type { Workspace } from "../types.js";

interface WorkspaceRow {
  id: string;
  tenant_id: string;
  name: string | null;
  created_at: Date;
}

function rowToWorkspace(row: WorkspaceRow): Workspace {
  const ws: Workspace = {
    id: row.id,
    tenantId: row.tenant_id,
    createdAt: new Date(row.created_at),
  };
  if (row.name != null) ws.name = row.name;
  return ws;
}

/**
 * Workspaces are tenant-scoped (PK is `(tenant_id, id)`). A user-supplied id is
 * used as-is; an unspecified one is auto-generated. `create` is idempotent
 * (ON CONFLICT DO NOTHING + read-back) so the same Workspace can be bound by
 * many Sessions concurrently. See ADR-0002 §4.
 */
export class PgWorkspaceMetadataStore implements WorkspaceMetadataStore {
  constructor(private readonly pool: Pool) {}

  async create(input: WorkspaceMetadataStoreCreateInput): Promise<Workspace> {
    const now = new Date();
    const id = input.id ?? `ws_${nanoid()}`;
    const { rows } = await this.pool.query<WorkspaceRow>(
      `INSERT INTO workspaces (id, tenant_id, name, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, id) DO NOTHING
       RETURNING *`,
      [id, input.tenantId, input.name ?? null, now],
    );
    if (rows[0]) return rowToWorkspace(rows[0]);

    const existing = await this.getById(input.tenantId, id);
    if (!existing) {
      throw new Error(`PgWorkspaceMetadataStore.create: workspace ${id} missing after upsert`);
    }
    return existing;
  }

  async getById(tenantId: string, id: string): Promise<Workspace | null> {
    const { rows } = await this.pool.query<WorkspaceRow>(
      `SELECT * FROM workspaces WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    return rows[0] ? rowToWorkspace(rows[0]) : null;
  }

  async list(tenantId: string): Promise<Workspace[]> {
    const { rows } = await this.pool.query<WorkspaceRow>(
      `SELECT * FROM workspaces WHERE tenant_id = $1 ORDER BY created_at ASC`,
      [tenantId],
    );
    return rows.map(rowToWorkspace);
  }

  async update(
    tenantId: string,
    id: string,
    input: WorkspaceMetadataStoreUpdateInput,
  ): Promise<Workspace | null> {
    if (input.name === undefined) return this.getById(tenantId, id);
    const { rows } = await this.pool.query<WorkspaceRow>(
      `UPDATE workspaces SET name = $3 WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [tenantId, id, input.name],
    );
    return rows[0] ? rowToWorkspace(rows[0]) : null;
  }
}
