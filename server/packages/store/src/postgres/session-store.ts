import { nanoid } from "nanoid";
import type { Pool } from "./connection.js";
import type { SessionStore, SessionStoreCreateInput, SessionStoreListOpts } from "../interfaces/session-store.js";
import type { PendingEventFence } from "../interfaces/pending-event-store.js";
import type { Agent, PaginatedResult, Session, SessionStatus } from "../types.js";
import { PendingEventClaimLostError } from "../errors.js";

interface SessionRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  status: SessionStatus;
  title: string | null;
  agent: Agent;
  workspace_id: string;
  loop_id: string | null;
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
    loopId: row.loop_id ?? undefined,
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
      `INSERT INTO sessions (id, tenant_id, agent_id, status, agent, workspace_id, loop_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [id, input.tenantId, input.agentId, "idle", JSON.stringify(input.agent), input.workspaceId, input.loopId ?? null, now, now],
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
    if (opts?.agentId) {
      params.push(opts.agentId);
      where += ` AND agent_id = $${params.length}`;
    }
    if (opts?.status) {
      params.push(opts.status);
      where += ` AND status = $${params.length}`;
    }
    if (opts?.loopId) {
      params.push(opts.loopId);
      where += ` AND loop_id = $${params.length}`;
    }
    if (opts?.withoutLoop) {
      where += ` AND loop_id IS NULL`;
    }
    if (opts?.cursor) {
      if (opts.loopId) {
        const cursor = await this.pool.query<Pick<SessionRow, "created_at">>(
          `SELECT created_at FROM sessions
           WHERE tenant_id = $1 AND loop_id = $2 AND id = $3`,
          [tenantId, opts.loopId, opts.cursor],
        );
        if (!cursor.rows[0]) return { data: [], hasMore: false };
        params.push(cursor.rows[0].created_at);
        const createdAtParam = params.length;
        params.push(opts.cursor);
        where += ` AND (created_at < $${createdAtParam}
          OR (created_at = $${createdAtParam} AND id < $${params.length}))`;
      } else {
        params.push(opts.cursor);
        where += ` AND id > $${params.length}`;
      }
    }
    params.push(limit + 1);
    const order = opts?.loopId
      ? "created_at DESC, id DESC"
      : "id ASC";
    const { rows } = await this.pool.query<SessionRow>(
      `SELECT * FROM sessions WHERE ${where} ORDER BY ${order} LIMIT $${params.length}`,
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

  async updateStatusIfClaimed(
    id: string,
    status: SessionStatus,
    fence: PendingEventFence,
  ): Promise<Session | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const session = await client.query<{ status: SessionStatus }>(
        `SELECT status FROM sessions WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!session.rows[0] || session.rows[0].status === "terminated") {
        await client.query("COMMIT");
        return null;
      }
      const locked = await client.query<{ id: string }>(
        `SELECT id FROM pending_events
         WHERE session_id = $1 AND id = $2
         FOR UPDATE`,
        [id, fence.eventId],
      );
      if (!locked.rows[0]) {
        throw new PendingEventClaimLostError(
          id,
          fence.eventId,
          fence.ownerId,
          fence.generation,
        );
      }
      const live = await client.query<{ id: string }>(
        `SELECT id FROM pending_events
         WHERE session_id = $1
           AND id = $2
           AND claim_owner = $3
           AND claim_generation = $4
           AND claim_expires_at > clock_timestamp()`,
        [id, fence.eventId, fence.ownerId, fence.generation],
      );
      if (!live.rows[0]) {
        throw new PendingEventClaimLostError(
          id,
          fence.eventId,
          fence.ownerId,
          fence.generation,
        );
      }
      const { rows } = await client.query<SessionRow>(
        `UPDATE sessions
         SET status = $2, updated_at = $3
         WHERE id = $1 AND status <> 'terminated'
         RETURNING *`,
        [id, status, new Date()],
      );
      await client.query("COMMIT");
      return rows[0] ? rowToSession(rows[0]) : null;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
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
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<{ id: string }>(
        `SELECT id FROM sessions WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!locked.rows[0]) {
        await client.query("COMMIT");
        return null;
      }
      const { rows } = await client.query<SessionRow>(
        `UPDATE sessions
         SET status = 'terminated', updated_at = $2, terminated_at = $2
         WHERE id = $1
         RETURNING *`,
        [id, now],
      );
      // Deleting retained input is the remote-Host fence: its next heartbeat,
      // durable append, checkpoint gate, or ack fails immediately.
      await client.query(`DELETE FROM pending_events WHERE session_id = $1`, [id]);
      await client.query("COMMIT");
      return rowToSession(rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}
