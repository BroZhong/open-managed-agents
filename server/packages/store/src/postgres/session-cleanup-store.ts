import type { Pool } from "./connection.js";

/** First retry of a failed cleanup; each further failure doubles it, up to the cap. */
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 600_000;
/** How long a claimed cleanup is left to its claimer: longer than its Sandbox control-plane calls take. */
export const CLEANUP_CLAIM_MS = 600_000;

/** A termination outbox, committed with revocation and retained until cleanup succeeds. */
export class PgSessionCleanupStore {
  constructor(private readonly pool: Pool) {}
  async sweep(cleanup: (sessionId: string) => Promise<boolean>): Promise<void> {
    // Bounded discovery. No in-memory Sandbox handle is required.
    const candidates = await this.pool.query<{ session_id: string }>(
      "SELECT session_id FROM session_cleanup WHERE completed_at IS NULL AND retry_at <= NOW() ORDER BY retry_at LIMIT 25",
    );
    for (const { session_id: id } of candidates.rows) {
      // One autocommitted claim: its retry_at is the claim's lease, so no
      // transaction or pooled client waits on the Sandbox calls cleanup
      // makes, and competing Runners skip the row until the lease ends. A
      // Runner lost meanwhile leaves the row to the next sweep after it.
      const claimed = await this.pool.query<{ attempts: number }>(
        "UPDATE session_cleanup SET retry_at=$2, attempts=attempts+1 WHERE session_id=$1 AND completed_at IS NULL AND retry_at <= NOW() RETURNING attempts",
        [id, new Date(Date.now() + CLEANUP_CLAIM_MS)]);
      if (!claimed.rows.length) continue;
      const { attempts } = claimed.rows[0];
      let completed = false;
      try { completed = await cleanup(id); }
      catch (error) { console.error(`Session cleanup retained for retry: ${id}`, error); }
      // Back off a cleanup that keeps failing: every Runner sweeps every
      // few seconds, and a row that cannot complete must not cost that forever.
      const delayMs = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
      // Only the current claim records its outcome: one that outlived its
      // lease leaves the row to the Runner that claimed it next.
      await this.pool.query("UPDATE session_cleanup SET completed_at=$2, retry_at=$3 WHERE session_id=$1 AND attempts=$4",
        [id, completed ? new Date() : null, new Date(Date.now() + delayMs), attempts]);
    }
  }
}
