import type { Pool } from "./connection.js";

/** A termination outbox, committed with revocation and retained until cleanup succeeds. */
export class PgSessionCleanupStore {
  constructor(private readonly pool: Pool) {}
  async sweep(cleanup: (sessionId: string) => Promise<boolean>): Promise<void> {
    // Bounded discovery; each row lock excludes competing Runners and releases
    // automatically on process death. No in-memory Sandbox handle is required.
    const candidates = await this.pool.query<{ session_id: string }>(
      "SELECT session_id FROM session_cleanup WHERE completed_at IS NULL AND retry_at <= NOW() ORDER BY retry_at LIMIT 25",
    );
    for (const { session_id: id } of candidates.rows) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const locked = await client.query("SELECT session_id FROM session_cleanup WHERE session_id=$1 AND completed_at IS NULL AND retry_at <= NOW() FOR UPDATE SKIP LOCKED", [id]);
        if (locked.rows.length) {
          let completed = false;
          try { completed = await cleanup(id); }
          catch (error) { console.error(`Session cleanup retained for retry: ${id}`, error); }
          await client.query("UPDATE session_cleanup SET completed_at=$2, retry_at=$3, attempts=attempts+1 WHERE session_id=$1", [id, completed ? new Date() : null, new Date(Date.now() + 5000)]);
        }
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
      finally { client.release(); }
    }
  }
}
