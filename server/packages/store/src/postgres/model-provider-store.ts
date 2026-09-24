import type { Pool } from "./connection.js";
import type {
  ModelProviderStore,
  ModelProviderRecord,
} from "../interfaces/model-provider-store.js";
export class PgModelProviderStore implements ModelProviderStore {
  constructor(private readonly pool: Pool) {}
  async list(tenantId: string): Promise<ModelProviderRecord[]> {
    const { rows } = await this.pool.query<{ config: ModelProviderRecord }>(
      "SELECT config FROM model_providers WHERE tenant_id = $1 ORDER BY id",
      [tenantId],
    );
    return rows.map((row) => row.config);
  }
  async get(tenantId: string, id: string): Promise<ModelProviderRecord | null> {
    const { rows } = await this.pool.query<{ config: ModelProviderRecord }>(
      "SELECT config FROM model_providers WHERE tenant_id = $1 AND id = $2",
      [tenantId, id],
    );
    return rows[0]?.config ?? null;
  }
  async save(record: ModelProviderRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO model_providers (tenant_id, id, config) VALUES ($1, $2, $3::jsonb)
      ON CONFLICT (tenant_id, id) DO UPDATE SET config = EXCLUDED.config`,
      [record.tenantId, record.id, JSON.stringify(record)],
    );
  }
  async delete(tenantId: string, id: string): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM model_providers WHERE tenant_id = $1 AND id = $2",
      [tenantId, id],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
