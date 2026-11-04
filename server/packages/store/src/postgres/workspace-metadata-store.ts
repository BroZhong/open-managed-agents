import { nanoid } from "nanoid";
import type { Pool } from "./connection.js";
import type {
  AgentWorkspaceListOptions,
  AgentWorkspaceListResult,
  WorkspaceMetadataStore,
  WorkspaceMetadataStoreCreateInput,
  WorkspaceMetadataStoreUpdateInput,
} from "../interfaces/workspace-metadata-store.js";
import type { Workspace } from "../types.js";

import { encodeWorkspaceUpdatedAtCursor, decodeWorkspaceUpdatedAtCursor } from "../workspace-list-cursor.js";

interface WorkspaceRow {
  deleted_at: Date | null;
  id: string;
  tenant_id: string;
  name: string | null;
  created_at: Date;
}

function rowToWorkspace(row: WorkspaceRow): Workspace {
  const ws: Workspace = {
    id: row.id,
    deletedAt: row.deleted_at ? new Date(row.deleted_at) : undefined,
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

  async list(tenantId: string, includeDeleted = false): Promise<Workspace[]> {
    const { rows } = await this.pool.query<WorkspaceRow>(
      `SELECT * FROM workspaces WHERE tenant_id = $1 ${includeDeleted ? "" : "AND deleted_at IS NULL"} ORDER BY created_at ASC`,
      [tenantId],
    );
    return rows.map(rowToWorkspace);
  }

  async listByAgent(tenantId: string, agentId: string, opts: AgentWorkspaceListOptions): Promise<AgentWorkspaceListResult> {
    const params: unknown[] = [tenantId, agentId];
    let boundary = "";
    if (opts.cursor) {
      const cursor = decodeWorkspaceUpdatedAtCursor(opts.cursor);
      if (!cursor) return { data: [], hasMore: false };
      params.push(cursor.updatedAt, cursor.id);
      boundary = "WHERE (activity.updated_at < $3 OR (activity.updated_at = $3 AND w.id < $4))";
    }
    params.push(opts.limit + 1);
    const { rows } = await this.pool.query<WorkspaceRow & {
      updated_at: Date; has_running_sessions: boolean; cursor_updated_at: string;
    }>(
      `SELECT w.*, activity.updated_at, activity.has_running_sessions,
         to_char(activity.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.USTZH:TZM') AS cursor_updated_at
       FROM workspaces w
       JOIN (
         SELECT s.tenant_id, s.workspace_id, MAX(s.updated_at) AS updated_at,
           BOOL_OR(s.status IN ('running', 'waiting')) AS has_running_sessions
         FROM sessions s
         WHERE s.tenant_id = $1 AND s.agent_id = $2 AND s.deleted_at IS NULL
           AND s.loop_id IS NULL AND s.delegation->>'parentSessionId' IS NULL
         GROUP BY s.tenant_id, s.workspace_id
       ) activity ON activity.tenant_id = w.tenant_id AND activity.workspace_id = w.id
         AND w.tenant_id = $1 AND w.deleted_at IS NULL AND w.name IS NOT NULL AND w.name <> ''
       ${boundary}
       ORDER BY activity.updated_at DESC, w.id DESC LIMIT $${params.length}`,
      params,
    );
    const hasMore = rows.length > opts.limit;
    const page = rows.slice(0, opts.limit);
    const last = page.at(-1);
    return {
      data: page.map((row) => ({ ...rowToWorkspace(row), updatedAt: new Date(row.updated_at), hasRunningSessions: row.has_running_sessions })),
      hasMore,
      ...(hasMore && last ? { nextCursor: encodeWorkspaceUpdatedAtCursor(last.cursor_updated_at, last.id) } : {}),
    };
  }

  async softDelete(tenantId: string, id: string): Promise<Workspace | null> {
    const { rows } = await this.pool.query<WorkspaceRow>(
      `UPDATE workspaces SET deleted_at = COALESCE(deleted_at, $3) WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [tenantId, id, new Date()],
    );
    return rows[0] ? rowToWorkspace(rows[0]) : null;
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
