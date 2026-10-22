import type { Pool } from "./connection.js";

/** First retry of a failed cleanup; each further failure doubles it, up to the cap. */
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 600_000;

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
        const locked = await client.query<{ attempts: number }>("SELECT attempts FROM session_cleanup WHERE session_id=$1 AND completed_at IS NULL AND retry_at <= NOW() FOR UPDATE SKIP LOCKED", [id]);
        if (locked.rows.length) {
          let completed = false;
          try { completed = await cleanup(id); }
          catch (error) { console.error(`Session cleanup retained for retry: ${id}`, error); }
          // Back off a cleanup that keeps failing: every Runner sweeps every
          // few seconds, and a row that cannot complete must not cost that forever.
          const delayMs = Math.min(RETRY_BASE_MS * 2 ** locked.rows[0].attempts, RETRY_MAX_MS);
          await client.query("UPDATE session_cleanup SET completed_at=$2, retry_at=$3, attempts=attempts+1 WHERE session_id=$1", [id, completed ? new Date() : null, new Date(Date.now() + delayMs)]);
        }
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
      finally { client.release(); }
    }
  }
}
