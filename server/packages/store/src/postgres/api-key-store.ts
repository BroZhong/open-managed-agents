import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import type { Pool } from "./connection.js";
import type { ApiKeyCreateResult, ApiKeyStore } from "../interfaces/api-key-store.js";
import type { ApiKey } from "../types.js";

interface ApiKeyRow {
  id: string;
  tenant_id: string;
  name: string;
  key_hash: string;
  prefix: string;
  created_at: Date;
}

function rowToApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    keyHash: row.key_hash,
    prefix: row.prefix,
    createdAt: new Date(row.created_at),
  };
}

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export class PgApiKeyStore implements ApiKeyStore {
  constructor(private readonly pool: Pool) {}

  async create(tenantId: string, name: string): Promise<ApiKeyCreateResult> {
    const rawKey = `omak_${nanoid(32)}`;
    const prefix = rawKey.slice(0, 9);
    const now = new Date();
    const id = `apikey_${nanoid()}`;

    const { rows } = await this.pool.query<ApiKeyRow>(
      `INSERT INTO api_keys (id, tenant_id, name, key_hash, prefix, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [id, tenantId, name, hashKey(rawKey), prefix, now],
    );
    return { apiKey: rowToApiKey(rows[0]), rawKey };
  }

  async validate(rawKey: string): Promise<ApiKey | null> {
    const { rows } = await this.pool.query<ApiKeyRow>(
      `SELECT * FROM api_keys WHERE key_hash = $1`,
      [hashKey(rawKey)],
    );
    return rows[0] ? rowToApiKey(rows[0]) : null;
  }

  /**
   * Look up a tenant by the SHA-256 hash of an API key. Used by the API auth
   * middleware (which hashes the presented raw key itself). Beyond the
   * ApiKeyStore interface but mirrors InMemoryApiKeyStore.
   */
  async findByKeyHash(keyHash: string): Promise<{ tenantId: string } | null> {
    const { rows } = await this.pool.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM api_keys WHERE key_hash = $1`,
      [keyHash],
    );
    return rows[0] ? { tenantId: rows[0].tenant_id } : null;
  }

  async list(tenantId: string): Promise<ApiKey[]> {
    const { rows } = await this.pool.query<ApiKeyRow>(
      `SELECT * FROM api_keys WHERE tenant_id = $1`,
      [tenantId],
    );
    return rows.map(rowToApiKey);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM api_keys WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) === 1;
  }
}
