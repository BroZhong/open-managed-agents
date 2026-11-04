import type { Pool } from "./connection.js";

/**
 * What the Runners have to do now, as KEDA scales them on it (ADR-0026). Each
 * Session counts once, by its head input: the one a claim takes and a lease is
 * held on, whatever is queued behind it.
 */
export interface RunnerDemand {
  /** `executing + ready`: the Turns that occupy, or wait for, a Runner slot. */
  demand: number;
  /** Heads under a live lease that are not in a synchronous wait, Child Sessions included. */
  executing: number;
  /**
   * Heads under a live lease whose Turn waits synchronously for a Delegation
   * Result. A Runner holds their claim but does not count them against its
   * Runner Capacity, so neither does the demand.
   */
  syncWaiting: number;
  /** Heads no live lease holds, of Sessions not terminated: input waiting for a Runner. */
  ready: number;
  /** The database clock when the counts were taken. */
  observedAt: Date;
}

/**
 * One statement, so the four counts are of one snapshot. The lease predicate
 * is the claim's: an unowned head, or one whose lease lapsed, is claimable.
 * A synchronous wait is the head input's `waiting` delegation wait (the wait
 * `Agent` without `run_in_background` and `get_subagent_result` with `wait`
 * save). `sessions.status` decides only readiness: a terminated Session's
 * input never runs again, while its live lease still occupies a Runner until
 * the attempt stops; a head whose Session row is gone is not ready either.
 * The CASE probes the Session only of an unleased head and the waits only of
 * a leased one, and the materialized CTE evaluates each probe once. About
 * 15 ms for 2500 Sessions, whether the planner probes by key or hashes.
 */
const DEMAND_SQL = `
  WITH head AS (
    SELECT DISTINCT ON (session_id) session_id, id,
      claim_owner IS NOT NULL AND claim_expires_at > clock_timestamp() AS leased
    FROM pending_events
    ORDER BY session_id, seq
  ), turn AS MATERIALIZED (
    SELECT CASE
      WHEN NOT head.leased THEN CASE WHEN EXISTS (
        SELECT 1 FROM sessions session WHERE session.id = head.session_id AND session.status <> 'terminated'
      ) THEN 'ready' END
      WHEN EXISTS (
        SELECT 1 FROM delegation_waits wait
        WHERE wait.record->>'callerSessionId' = head.session_id
          AND wait.record->>'parentPendingEventId' = head.id
          AND wait.record->>'status' = 'waiting'
      ) THEN 'sync_waiting'
      ELSE 'executing' END AS state
    FROM head
  )
  SELECT
    COUNT(*) FILTER (WHERE state = 'executing')::int AS executing,
    COUNT(*) FILTER (WHERE state = 'sync_waiting')::int AS sync_waiting,
    COUNT(*) FILTER (WHERE state = 'ready')::int AS ready,
    now() AS observed_at
  FROM turn`;

/**
 * Reads the Runner demand for the API's internal endpoint. Every read queries
 * the queue afresh; nothing is cached, because a stale demand scales the
 * Runners on work that is gone or not yet seen.
 */
export class PgRunnerDemandStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Rejects once `timeoutMs` has passed, a pool checkout included: KEDA must
   * see a failure, never a late or zero demand. The statement timeout also
   * ends the query on the server, so a stalled read does not keep its
   * connection after its caller has given up.
   */
  async read(timeoutMs: number): Promise<RunnerDemand> {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("Runner demand timeoutMs must be a positive integer");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const query = this.query(timeoutMs);
    // A read that loses the race settles later; its rejection is not news.
    query.catch(() => {});
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Runner demand read timed out after ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      return await Promise.race([query, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async query(timeoutMs: number): Promise<RunnerDemand> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SELECT set_config('statement_timeout', $1, true)", [`${timeoutMs}ms`]);
      const { rows: [row] } = await client.query<{ executing: number; sync_waiting: number; ready: number; observed_at: Date }>(DEMAND_SQL);
      await client.query("COMMIT");
      return {
        demand: row.executing + row.ready,
        executing: row.executing,
        syncWaiting: row.sync_waiting,
        ready: row.ready,
        observedAt: new Date(row.observed_at),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}
