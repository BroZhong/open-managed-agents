import type { ModelProviderRecord } from "../interfaces/model-provider-store.js";
import type { Pool } from "./connection.js";

/** Mark old booleans as source-unknown. The deployed Pi catalog remains the
 * authority for exact/reference capabilities, rather than freezing a snapshot. */
export function upgradeLegacyModelProvider(record: ModelProviderRecord): ModelProviderRecord {
  return {
    ...record,
    models: record.models.map((model) =>
      model.capabilityVersion !== undefined || model.reasoningSource !== undefined ||
      model.capabilityReference !== undefined || model.thinkingProfile !== undefined || model.thinkingMode !== undefined
        ? model
        : { ...model, reasoning: true, reasoningSource: "legacy", capabilityVersion: 1 },
    ),
  };
}

/** Dry-run by default; bounded pages and compare-and-swap make retries safe.
 * No credential decryption, upstream discovery or inference occurs here. */
export async function migrateModelProviderCapabilities(pool: Pool, options: { apply?: boolean } = {}) {
  const stats = { scanned: 0, candidates: 0, updated: 0, conflicts: 0 };
  let tenantId = "", id = "";
  for (;;) {
    const page = await pool.query<{ tenant_id: string; id: string; config: ModelProviderRecord }>(
      `SELECT tenant_id, id, config FROM model_providers
       WHERE tenant_id > $1 OR (tenant_id = $1 AND id > $2)
       ORDER BY tenant_id, id LIMIT 50`, [tenantId, id]);
    if (!page.rows.length) break;
    for (const row of page.rows) {
      tenantId = row.tenant_id; id = row.id; stats.scanned++;
      const original = JSON.stringify(row.config);
      const upgraded = JSON.stringify(upgradeLegacyModelProvider(row.config));
      if (original === upgraded) continue;
      stats.candidates++;
      if (!options.apply) continue;
      const changed = await pool.query(
        "UPDATE model_providers SET config=$1::jsonb WHERE tenant_id=$2 AND id=$3 AND config=$4::jsonb",
        [upgraded, tenantId, id, original]);
      if (changed.rowCount) stats.updated++; else stats.conflicts++;
    }
  }
  return stats;
}
