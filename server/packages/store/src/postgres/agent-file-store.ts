import type { Pool } from "./connection.js";
import type {
  AgentFile,
  AgentFileStore,
  AgentFileSummary,
} from "../interfaces/agent-file-store.js";

interface AgentFileRow {
  filename: string;
  content: string;
  updated_at: Date;
}

export class PgAgentFileStore implements AgentFileStore {
  constructor(private readonly pool: Pool) {}

  async list(tenantId: string, agentId: string): Promise<AgentFileSummary[]> {
    const { rows } = await this.pool.query<AgentFileRow>(
      `SELECT filename, updated_at FROM agent_files
       WHERE tenant_id = $1 AND agent_id = $2
       ORDER BY filename ASC`,
      [tenantId, agentId],
    );
    return rows.map((row) => ({
      filename: row.filename,
      updatedAt: new Date(row.updated_at),
    }));
  }

  async get(tenantId: string, agentId: string, filename: string): Promise<AgentFile | null> {
    const { rows } = await this.pool.query<AgentFileRow>(
      `SELECT filename, content, updated_at FROM agent_files
       WHERE tenant_id = $1 AND agent_id = $2 AND filename = $3`,
      [tenantId, agentId, filename],
    );
    return rows[0]
      ? { filename: rows[0].filename, content: rows[0].content, updatedAt: new Date(rows[0].updated_at) }
      : null;
  }

  async upsert(
    tenantId: string,
    agentId: string,
    filename: string,
    content: string,
  ): Promise<AgentFile> {
    const now = new Date();
    const { rows } = await this.pool.query<AgentFileRow>(
      `INSERT INTO agent_files (tenant_id, agent_id, filename, content, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, agent_id, filename)
       DO UPDATE SET content = EXCLUDED.content, updated_at = EXCLUDED.updated_at
       RETURNING filename, content, updated_at`,
      [tenantId, agentId, filename, content, now],
    );
    return { filename: rows[0].filename, content: rows[0].content, updatedAt: new Date(rows[0].updated_at) };
  }

  async delete(tenantId: string, agentId: string, filename: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM agent_files WHERE tenant_id = $1 AND agent_id = $2 AND filename = $3`,
      [tenantId, agentId, filename],
    );
    return (result.rowCount ?? 0) === 1;
  }
}
