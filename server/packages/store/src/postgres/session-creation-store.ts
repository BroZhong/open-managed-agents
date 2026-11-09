import { nanoid } from "nanoid";
import type { SessionCreationStore } from "../interfaces/session-creation-store.js";
import { sessionCreationFingerprint, SessionCreationConflictError, SessionWorkspaceDeletedError } from "../interfaces/session-creation-store.js";
import type { Pool } from "./connection.js";
import { insertSession, rowToSession } from "./session-store.js";
import { PgWorkspaceMetadataStore } from "./workspace-metadata-store.js";

async function replay(db: Pick<Pool, "query">, tenantId: string, key: string, fingerprint: string) {
  const { rows: [existing] } = await db.query<{ request: string; session_id: string }>(
    "SELECT request, session_id FROM session_creation_keys WHERE tenant_id = $1 AND key = $2", [tenantId, key],
  );
  if (!existing) return null;
  if (existing.request !== fingerprint) throw new SessionCreationConflictError(existing.session_id);
  const { rows: [row] } = await db.query("SELECT * FROM sessions WHERE tenant_id = $1 AND id = $2", [tenantId, existing.session_id]);
  if (!row) throw new Error("Idempotent Session is missing");
  return rowToSession(row);
}

export class PgSessionCreationStore implements SessionCreationStore {
  constructor(private readonly pool: Pool) {}

  async create(...[tenantId, key, request, prepare]: Parameters<SessionCreationStore["create"]>) {
    const fingerprint = sessionCreationFingerprint(request);
    const existing = await replay(this.pool, tenantId, key, fingerprint);
    if (existing) return existing;
    // Resolve Agent/Environment before checking out a transaction connection:
    // prepare may itself need the same pool. Replay never resolves new defaults.
    const prepared = await prepare();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const sessionId = `sess_${nanoid()}`;
      // The unique constraint waits for any concurrent creator to commit or
      // roll back. Reservation and resources become visible in one commit.
      const reserved = await client.query(
        `INSERT INTO session_creation_keys (tenant_id, key, request, session_id)
         VALUES ($1, $2, $3, $4) ON CONFLICT (tenant_id, key) DO NOTHING RETURNING session_id`,
        [tenantId, key, fingerprint, sessionId],
      );
      if (!reserved.rows.length) {
        const session = await replay(client, tenantId, key, fingerprint);
        if (!session) throw new Error("Session creation reservation disappeared");
        await client.query("COMMIT");
        return session;
      }
      const workspace = await new PgWorkspaceMetadataStore(client).create({ tenantId, id: request.workspaceId, name: request.workspaceName });
      if (workspace.deletedAt) throw new SessionWorkspaceDeletedError();
      const session = await insertSession(client, {
        tenantId, agentId: prepared.agent.id, ...prepared, workspaceId: workspace.id,
      }, sessionId);
      await client.query("COMMIT");
      return session;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
