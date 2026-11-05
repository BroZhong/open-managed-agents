import { createPgPool, type PgConnectionConfig, type Pool, type PoolClient } from "./connection.js";
import type { Leadership } from "../interfaces/leadership.js";

/**
 * The connection notices a peer gone within about a minute (30 s idle, then
 * 3 probes 10 s apart), on the server's side: a Runner that vanished without
 * closing its socket (its node lost) releases the lead that soon instead of
 * after the server's default keepalive, hours.
 */
const KEEPALIVE = "SET tcp_keepalives_idle = 30; SET tcp_keepalives_interval = 10; SET tcp_keepalives_count = 3";

/**
 * The lead of a role among the Runners of a schema (ADR-0026), held as a
 * session-level advisory lock on a connection of its own: the lock lasts
 * exactly as long as the session, so a Runner that stops or vanishes
 * releases it with its connection, and the next Runner to ask takes it.
 *
 * Keyed by the pair (schema, role): production `oma` and test `oma_test`
 * share one database, and each environment's Runners elect their own. The
 * two-key form is a key space of its own, apart from the single 64-bit
 * keys of transaction locks.
 *
 * The connection is never one of the Runner's pool. ADR-0023 rejected a
 * session lock because one held on a pooled client across gateway calls
 * leaves the pool one client short, the pattern behind the Runner pool
 * deadlock; this one comes from a pool of one client that nothing else
 * uses, so a leader's work queries the Runner's pool as before. A Runner
 * that does not lead opens it only to ask, once a period, and closes it.
 * The session's `application_name` names the Runner, so the leader can be
 * found in `pg_locks` joined to `pg_stat_activity`.
 */
export class PgAdvisoryLeadership implements Leadership {
  private readonly pool: Pool;
  /** The session that holds the lock, while this Runner leads. */
  private client?: PoolClient;
  private closed = false;

  constructor(config: PgConnectionConfig, private readonly role: string, private readonly applicationName: string) {
    this.pool = createPgPool({ ...config, max: 1 });
  }

  async hold(): Promise<boolean> {
    if (this.closed) return false;
    if (this.client) {
      // The lock is held as long as its session is: a session that still
      // answers still holds it.
      try { await this.client.query("SELECT 1"); return true; }
      catch { this.drop(); }
    }
    const client = await this.pool.connect();
    try {
      await client.query(KEEPALIVE);
      await client.query("SELECT set_config('application_name', $1, false)", [this.applicationName]);
      const { rows: [row] } = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext(current_schema()), hashtext($1)) AS locked", [this.role]);
      if (!row.locked || this.closed) { client.release(true); return false; }
      this.client = client;
      return true;
    } catch (error) {
      client.release(true);
      throw error;
    }
  }

  /** Ending the session releases its lock: no unlock that a lost database could stall. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.drop();
    await this.pool.end();
  }

  private drop(): void {
    this.client?.release(true);
    this.client = undefined;
  }
}
