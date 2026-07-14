import { nanoid } from "nanoid";
import type { Pool, PoolClient } from "./connection.js";
import type {
  Agent,
  Loop,
  LoopDispatch,
  Session,
} from "../types.js";
import type {
  LoopStore,
  LoopStoreCreateInput,
  LoopStoreUpdateInput,
} from "../interfaces/loop-store.js";

interface LoopRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  name: string;
  description: string | null;
  prompt: string;
  interval_minutes: number;
  enabled: boolean;
  next_run_at: Date;
  last_run_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface AgentRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  model: string;
  system: string;
  runtime: Agent["runtime"];
  tools: Agent["tools"] | null;
  mcp_servers: Agent["mcpServers"] | null;
  skills: Agent["skills"] | null;
  sandbox: Agent["sandbox"] | null;
  created_at: Date;
  updated_at: Date;
}

function rowToLoop(row: LoopRow): Loop {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    name: row.name,
    description: row.description ?? undefined,
    prompt: row.prompt,
    intervalMinutes: row.interval_minutes,
    enabled: row.enabled,
    nextRunAt: new Date(row.next_run_at),
    lastRunAt: row.last_run_at ? new Date(row.last_run_at) : undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function rowToAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description ?? undefined,
    model: row.model,
    system: row.system,
    runtime: row.runtime,
    tools: row.tools ?? undefined,
    mcpServers: row.mcp_servers ?? undefined,
    skills: row.skills ?? undefined,
    sandbox: row.sandbox ?? undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function validateInterval(intervalMinutes: number): void {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5) {
    throw new RangeError("Loop intervalMinutes must be an integer of at least 5");
  }
}

function nextRun(now: Date, intervalMinutes: number): Date {
  return new Date(now.getTime() + intervalMinutes * 60_000);
}

export class PgLoopStore implements LoopStore {
  constructor(private readonly pool: Pool) {}

  async create(input: LoopStoreCreateInput): Promise<Loop> {
    validateInterval(input.intervalMinutes);
    const id = `loop_${nanoid()}`;
    const { rows } = await this.pool.query<LoopRow>(
      `INSERT INTO loops
        (id, tenant_id, agent_id, name, description, prompt, interval_minutes,
         enabled, next_run_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
       RETURNING *`,
      [
        id,
        input.tenantId,
        input.agentId,
        input.name,
        input.description ?? null,
        input.prompt,
        input.intervalMinutes,
        input.enabled,
        nextRun(input.now, input.intervalMinutes),
        input.now,
      ],
    );
    return rowToLoop(rows[0]);
  }

  async getById(id: string): Promise<Loop | null> {
    const { rows } = await this.pool.query<LoopRow>(
      `SELECT * FROM loops WHERE id = $1`,
      [id],
    );
    return rows[0] ? rowToLoop(rows[0]) : null;
  }

  async list(tenantId: string, agentId: string): Promise<Loop[]> {
    const { rows } = await this.pool.query<LoopRow>(
      `SELECT * FROM loops
       WHERE tenant_id = $1 AND agent_id = $2
       ORDER BY created_at ASC, id ASC`,
      [tenantId, agentId],
    );
    return rows.map(rowToLoop);
  }

  async update(
    id: string,
    tenantId: string,
    input: LoopStoreUpdateInput,
  ): Promise<Loop | null> {
    if (input.intervalMinutes !== undefined) validateInterval(input.intervalMinutes);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existingResult = await client.query<LoopRow>(
        `SELECT * FROM loops
         WHERE id = $1 AND tenant_id = $2
         FOR UPDATE`,
        [id, tenantId],
      );
      const existingRow = existingResult.rows[0];
      if (!existingRow) {
        await client.query("COMMIT");
        return null;
      }

      const intervalMinutes = input.intervalMinutes ?? existingRow.interval_minutes;
      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (column: string, value: unknown) => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };
      if (input.name !== undefined) set("name", input.name);
      if (input.description !== undefined) set("description", input.description);
      if (input.prompt !== undefined) set("prompt", input.prompt);
      if (input.intervalMinutes !== undefined) set("interval_minutes", input.intervalMinutes);
      if (input.enabled !== undefined) set("enabled", input.enabled);
      if (
        input.intervalMinutes !== undefined ||
        (input.enabled === true && !existingRow.enabled)
      ) {
        set("next_run_at", nextRun(input.now, intervalMinutes));
      }
      set("updated_at", input.now);
      params.push(id, tenantId);
      const { rows } = await client.query<LoopRow>(
        `UPDATE loops
         SET ${sets.join(", ")}
         WHERE id = $${params.length - 1} AND tenant_id = $${params.length}
         RETURNING *`,
        params,
      );
      await client.query("COMMIT");
      return rowToLoop(rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async dispatchDue(now: Date, limit: number): Promise<LoopDispatch[]> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError("Loop dispatch limit must be a positive integer");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<LoopRow>(
        `SELECT * FROM loops
         WHERE loops.enabled = true
           AND loops.next_run_at <= $1
         ORDER BY loops.next_run_at ASC, loops.id ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [now, limit],
      );
      const dispatched: LoopDispatch[] = [];
      for (const row of rows) {
        const result = await this.dispatchLocked(client, row, now, true);
        if (result) dispatched.push(result);
      }
      await client.query("COMMIT");
      return dispatched;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async dispatchNow(id: string, tenantId: string, now: Date): Promise<LoopDispatch | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<LoopRow>(
        `SELECT * FROM loops
         WHERE id = $1 AND tenant_id = $2
         FOR UPDATE`,
        [id, tenantId],
      );
      if (!rows[0]) {
        await client.query("COMMIT");
        return null;
      }
      const dispatched = await this.dispatchLocked(client, rows[0], now, false);
      await client.query("COMMIT");
      return dispatched;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  private async dispatchLocked(
    client: PoolClient,
    row: LoopRow,
    now: Date,
    advanceSchedule: boolean,
  ): Promise<LoopDispatch | null> {
    const agentResult = await client.query<AgentRow>(
      `SELECT * FROM agents WHERE id = $1 AND tenant_id = $2`,
      [row.agent_id, row.tenant_id],
    );
    // Agents are deliberately soft-linked throughout the schema. If one was
    // deleted after its Loop was created, retire that orphan under the same
    // row lock instead of failing every scheduler poll forever.
    if (!agentResult.rows[0]) {
      await client.query(
        `UPDATE loops SET enabled = false, updated_at = $2 WHERE id = $1`,
        [row.id, now],
      );
      return null;
    }
    const agent = rowToAgent(agentResult.rows[0]);
    const workspaceId = `ws_${nanoid()}`;
    const sessionId = `sess_${nanoid()}`;
    await client.query(
      `INSERT INTO workspaces (id, tenant_id, created_at) VALUES ($1, $2, $3)`,
      [workspaceId, row.tenant_id, now],
    );
    const sessionResult = await client.query<{
      id: string;
      tenant_id: string;
      agent_id: string;
      status: Session["status"];
      title: string | null;
      agent: Agent;
      workspace_id: string;
      loop_id: string | null;
      created_at: Date;
      updated_at: Date;
      terminated_at: Date | null;
    }>(
      `INSERT INTO sessions
        (id, tenant_id, agent_id, status, title, agent, workspace_id, loop_id,
         created_at, updated_at)
       VALUES ($1, $2, $3, 'idle', $4, $5, $6, $7, $8, $8)
       RETURNING *`,
      [sessionId, row.tenant_id, row.agent_id, row.name, JSON.stringify(agent), workspaceId, row.id, now],
    );
    await client.query(
      `INSERT INTO pending_events
        (id, session_id, type, data, session_thread_id, arrived_at)
       VALUES ($1, $2, 'user.message', $3, 'sthr_primary', $4)`,
      [
        `pending_${nanoid()}`,
        sessionId,
        JSON.stringify({ content: [{ type: "text", text: row.prompt }] }),
        now,
      ],
    );

    let loopRow = row;
    if (advanceSchedule) {
      const updated = await client.query<LoopRow>(
        `UPDATE loops
         SET last_run_at = $2, next_run_at = $3, updated_at = $2
         WHERE id = $1
         RETURNING *`,
        [row.id, now, nextRun(now, row.interval_minutes)],
      );
      loopRow = updated.rows[0];
    }
    const sessionRow = sessionResult.rows[0];
    const session: Session = {
      id: sessionRow.id,
      tenantId: sessionRow.tenant_id,
      agentId: sessionRow.agent_id,
      status: sessionRow.status,
      title: sessionRow.title ?? undefined,
      agent: {
        ...sessionRow.agent,
        createdAt: new Date(sessionRow.agent.createdAt),
        updatedAt: new Date(sessionRow.agent.updatedAt),
      },
      workspaceId: sessionRow.workspace_id,
      loopId: sessionRow.loop_id ?? undefined,
      createdAt: new Date(sessionRow.created_at),
      updatedAt: new Date(sessionRow.updated_at),
      terminatedAt: sessionRow.terminated_at ? new Date(sessionRow.terminated_at) : undefined,
    };
    return { loop: rowToLoop(loopRow), session };
  }
}
