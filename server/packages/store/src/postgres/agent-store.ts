import { nanoid } from "nanoid";
import type { Pool } from "./connection.js";
import type { AgentStore, AgentStoreCreateInput, AgentStoreListOpts, AgentStoreUpdateInput } from "../interfaces/agent-store.js";
import type { Agent, PaginatedResult } from "../types.js";

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

function toJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

export class PgAgentStore implements AgentStore {
  constructor(private readonly pool: Pool) {}

  async create(input: AgentStoreCreateInput): Promise<Agent> {
    const now = new Date();
    const id = `agent_${nanoid()}`;
    const { rows } = await this.pool.query<AgentRow>(
      `INSERT INTO agents (id, tenant_id, name, description, model, system, runtime, tools, mcp_servers, skills, sandbox, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        id,
        input.tenantId,
        input.name,
        input.description ?? null,
        input.model,
        input.system,
        input.runtime,
        toJson(input.tools),
        toJson(input.mcpServers),
        toJson(input.skills),
        toJson(input.sandbox),
        now,
        now,
      ],
    );
    return rowToAgent(rows[0]);
  }

  async getById(id: string): Promise<Agent | null> {
    const { rows } = await this.pool.query<AgentRow>(`SELECT * FROM agents WHERE id = $1`, [id]);
    return rows[0] ? rowToAgent(rows[0]) : null;
  }

  async list(tenantId: string, opts?: AgentStoreListOpts): Promise<PaginatedResult<Agent>> {
    const limit = opts?.limit ?? 20;
    const params: unknown[] = [tenantId];
    let where = `tenant_id = $1`;
    if (opts?.cursor) {
      params.push(opts.cursor);
      where += ` AND id > $${params.length}`;
    }
    params.push(limit + 1);
    const { rows } = await this.pool.query<AgentRow>(
      `SELECT * FROM agents WHERE ${where} ORDER BY id ASC LIMIT $${params.length}`,
      params,
    );

    const hasMore = rows.length > limit;
    const data = (hasMore ? rows.slice(0, limit) : rows).map(rowToAgent);
    return { data, hasMore };
  }

  async update(id: string, input: AgentStoreUpdateInput): Promise<Agent | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const addSet = (col: string, value: unknown, json = false) => {
      params.push(json ? toJson(value) : value);
      sets.push(`${col} = $${params.length}`);
    };

    if (input.name !== undefined) addSet("name", input.name);
    if (input.description !== undefined) addSet("description", input.description);
    if (input.model !== undefined) addSet("model", input.model);
    if (input.system !== undefined) addSet("system", input.system);
    if (input.runtime !== undefined) addSet("runtime", input.runtime);
    if (input.tools !== undefined) addSet("tools", input.tools, true);
    if (input.mcpServers !== undefined) addSet("mcp_servers", input.mcpServers, true);
    if (input.skills !== undefined) addSet("skills", input.skills, true);
    if (input.sandbox !== undefined) addSet("sandbox", input.sandbox, true);

    addSet("updated_at", new Date());

    params.push(id);
    const { rows } = await this.pool.query<AgentRow>(
      `UPDATE agents SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
      params,
    );
    return rows[0] ? rowToAgent(rows[0]) : null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM agents WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) === 1;
  }
}
