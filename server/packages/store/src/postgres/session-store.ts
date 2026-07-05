import { nanoid } from "nanoid";
import type { Pool } from "./connection.js";
import type { SessionStore, SessionStoreCreateInput, SessionStoreListOpts } from "../interfaces/session-store.js";
import type { Agent, PaginatedResult, Session, SessionStatus } from "../types.js";

interface SessionRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  status: SessionStatus;
  title: string | null;
  agent: Agent;
  workspace_id: string;
  created_at: Date;
  updated_at: Date;
  terminated_at: Date | null;
}

function reviveAgent(agent: Agent): Agent {
  return {
    ...agent,
    createdAt: new Date(agent.createdAt),
    updatedAt: new Date(agent.updatedAt),
  };
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    status: row.status,
    title: row.title ?? undefined,
    agent: reviveAgent(row.agent),
    workspaceId: row.workspace_id,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    terminatedAt: row.terminated_at ? new Date(row.terminated_at) : undefined,
  };
}

export class PgSessionStore implements SessionStore {
  constructor(private readonly pool: Pool) {}

  async create(input: SessionStoreCreateInput): Promise<Session> {
    const now = new Date();
    const id = `sess_${nanoid()}`;
    const { rows } = await this.pool.query<SessionRow>(
      `INSERT INTO sessions (id, tenant_id, agent_id, status, agent, workspace_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [id, input.tenantId, input.agentId, "idle", JSON.stringify(input.agent), input.workspaceId, now, now],
    );
    return rowToSession(rows[0]);
  }

  async getById(id: string): Promise<Session | null> {
    const { rows } = await this.pool.query<SessionRow>(`SELECT * FROM sessions WHERE id = $1`, [id]);
    return rows[0] ? rowToSession(rows[0]) : null;
  }

  async list(tenantId: string, opts?: SessionStoreListOpts): Promise<PaginatedResult<Session>> {
    const limit = opts?.limit ?? 20;
    const params: unknown[] = [tenantId];
    let where = `tenant_id = $1`;
    if (opts?.cursor) {
      params.push(opts.cursor);
      where += ` AND id > $${params.length}`;
    }
    if (opts?.agentId) {
      params.push(opts.agentId);
      where += ` AND agent_id = $${params.length}`;
    }
    if (opts?.status) {
      params.push(opts.status);
      where += ` AND status = $${params.length}`;
    }
    params.push(limit + 1);
    const { rows } = await this.pool.query<SessionRow>(
      `SELECT * FROM sessions WHERE ${where} ORDER BY id ASC LIMIT $${params.length}`,
      params,
    );

    const hasMore = rows.length > limit;
    const data = (hasMore ? rows.slice(0, limit) : rows).map(rowToSession);
    return { data, hasMore };
  }

  async updateStatus(id: string, status: SessionStatus): Promise<Session | null> {
    const { rows } = await this.pool.query<SessionRow>(
      `UPDATE sessions SET status = $2, updated_at = $3 WHERE id = $1 RETURNING *`,
      [id, status, new Date()],
    );
    return rows[0] ? rowToSession(rows[0]) : null;
  }

  async setTitle(id: string, title: string): Promise<Session | null> {
    const { rows } = await this.pool.query<SessionRow>(
      `UPDATE sessions SET title = $2, updated_at = $3 WHERE id = $1 RETURNING *`,
      [id, title, new Date()],
    );
    return rows[0] ? rowToSession(rows[0]) : null;
  }

  async terminate(id: string): Promise<Session | null> {
    const now = new Date();
    const { rows } = await this.pool.query<SessionRow>(
      `UPDATE sessions SET status = 'terminated', updated_at = $2, terminated_at = $2 WHERE id = $1 RETURNING *`,
      [id, now],
    );
    return rows[0] ? rowToSession(rows[0]) : null;
  }
}
