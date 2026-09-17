import { randomBytes } from "node:crypto";
import type { SessionShare, SessionShareStore } from "../interfaces/session-share-store.js";
import type { Pool } from "./connection.js";

export class PgSessionShareStore implements SessionShareStore {
  constructor(private readonly pool: Pool) {}
  async getById(id: string): Promise<SessionShare | null> {
    const { rows } = await this.pool.query<SessionShare>(
      `SELECT id, session_id AS "sessionId" FROM session_shares WHERE id = $1`, [id],
    );
    return rows[0] ?? null;
  }
  async getOrCreate(sessionId: string): Promise<SessionShare> {
    const { rows } = await this.pool.query<SessionShare>(
      `INSERT INTO session_shares (id, session_id) VALUES ($1, $2)
       ON CONFLICT (session_id) DO UPDATE SET session_id = EXCLUDED.session_id
       RETURNING id, session_id AS "sessionId"`,
      [randomBytes(32).toString("base64url"), sessionId],
    );
    return rows[0];
  }
}
