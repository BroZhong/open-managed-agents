import type { Pool, PoolClient } from './connection.js';
import type { SandboxActivity, SandboxLifecycleStore, SandboxReclamation, SandboxSweepFacts, SandboxSweepStore } from '../interfaces/sandbox-lifecycle-store.js';

/**
 * Coordinates business execution and explicit termination, and gives the
 * sweeper (ADR-0023) its read. No idle clock: deadlines stay on the platform.
 */
export class PgSandboxLifecycleStore implements SandboxLifecycleStore, SandboxSweepStore {
  constructor(private readonly pool: Pool) {}
  async assertReady(): Promise<void> {
    const result = await this.pool.query("SELECT 1 FROM pg_trigger WHERE tgname = 'sandbox_input_coordination' AND tgrelid = 'pending_events'::regclass AND tgfoid = 'lock_sandbox_binding()'::regprocedure AND tgenabled IN ('O', 'A')");
    if (!result.rows.length) throw new Error('Sandbox execution requires the native lifecycle migration and input coordination trigger');
  }
  private async locked<T>(bindingId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO delegation_environments (id, sandbox_id) VALUES ($1, NULL) ON CONFLICT DO NOTHING', [bindingId]);
      await client.query('SELECT id FROM delegation_environments WHERE id = $1 FOR UPDATE', [bindingId]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async begin(activity: SandboxActivity): Promise<boolean> {
    return this.locked(activity.bindingId, async client => {
      const { rows: [environment] } = await client.query<{ reclaiming: boolean }>('SELECT reclaiming FROM delegation_environments WHERE id = $1', [activity.bindingId]);
      if (environment.reclaiming) return false;
      const fence = activity.fence;
      const owned = await client.query(`SELECT p.id FROM pending_events p JOIN sessions s ON s.id=p.session_id
        WHERE p.session_id=$1 AND p.id=$2 AND p.claim_owner=$3 AND p.claim_generation=$4
          AND p.claim_expires_at > clock_timestamp() AND s.status <> 'terminated'
          AND COALESCE(s.delegation->>'sandboxSessionId',s.id)=$5`, [activity.sessionId, fence.eventId, fence.ownerId, fence.generation, activity.bindingId]);
      if (!owned.rows.length) throw new Error('Cannot admit Sandbox use for a stale Turn owner');
      // Expiry itself never invokes idle. Only a newly admitted Turn supersedes
      // abandoned generations; its preparation installs a fresh finite deadline.
      await client.query(`DELETE FROM delegation_resource_uses u WHERE u.record->>'sandboxSessionId'=$1
        AND NOT EXISTS (SELECT 1 FROM pending_events p WHERE p.id=u.record->>'pendingEventId'
          AND p.claim_owner=u.record->>'ownerId' AND p.claim_generation=(u.record->>'generation')::bigint
          AND p.claim_expires_at > clock_timestamp())`, [activity.bindingId]);
      const record = { sessionId: activity.sessionId, sandboxSessionId: activity.bindingId,
        pendingEventId: fence.eventId, ownerId: fence.ownerId, generation: fence.generation, managedTurn: true };
      await client.query('INSERT INTO delegation_resource_uses (id, record) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET record=EXCLUDED.record', [fence.eventId, JSON.stringify(record)]);
      return true;
    });
  }
  async finish(activity: SandboxActivity, idle?: (id: string) => Promise<void>): Promise<void> {
    await this.locked(activity.bindingId, async client => {
      const removed = await client.query(`DELETE FROM delegation_resource_uses WHERE id=$1
        AND record->>'ownerId'=$2 AND (record->>'generation')::bigint=$3 RETURNING id`,
      [activity.fence.eventId, activity.fence.ownerId, activity.fence.generation]);
      if (!removed.rows.length) return; // A duplicate or superseded callback cannot shorten another Turn.
      const busy = await client.query(`SELECT 1 FROM delegation_resource_uses WHERE record->>'sandboxSessionId'=$1
        UNION ALL SELECT 1 FROM pending_events p JOIN sessions s ON s.id=p.session_id
        WHERE COALESCE(s.delegation->>'sandboxSessionId',s.id)=$1 LIMIT 1`, [activity.bindingId]);
      if (busy.rows.length) return;
      const { rows: [binding] } = await client.query<{ sandbox_id: string | null; reclaiming: boolean }>('SELECT sandbox_id, reclaiming FROM delegation_environments WHERE id=$1', [activity.bindingId]);
      if (binding.sandbox_id && !binding.reclaiming) await idle?.(binding.sandbox_id);
      // External timeout writes have no fencing token. A remote late response
      // may beat a newer 24h write even though normal admission is serialized.
    });
  }
  async claimReclamation(bindingId: string): Promise<SandboxReclamation | null> {
    return this.locked(bindingId, async client => {
      const { rows: [row] } = await client.query<{ sandbox_id: string | null; creating_since: Date | null; now: Date; reclaiming: boolean }>(
        'SELECT sandbox_id, creating_since, now() AS now, reclaiming FROM delegation_environments WHERE id=$1', [bindingId]);
      // Whatever the row records, even nothing: a lost create can leave a
      // Sandbox only the gateway knows, and reclamation kills it by binding.
      const ticket: SandboxReclamation = { bindingId, sandboxId: row.sandbox_id, creatingSince: row.creating_since, now: row.now };
      if (row.reclaiming) return ticket;
      const busy = await client.query(`SELECT 1 FROM delegation_resource_uses u JOIN sessions s ON s.id=u.record->>'sessionId'
        WHERE u.record->>'sandboxSessionId'=$1 AND s.status <> 'terminated'
        UNION ALL SELECT 1 FROM pending_events p JOIN sessions s ON s.id=p.session_id
        WHERE COALESCE(s.delegation->>'sandboxSessionId',s.id)=$1 AND s.status <> 'terminated' LIMIT 1`, [bindingId]);
      if (busy.rows.length) return null;
      await client.query('UPDATE delegation_environments SET reclaiming=TRUE WHERE id=$1', [bindingId]);
      return ticket;
    });
  }
  async completeReclamation(ticket: SandboxReclamation): Promise<void> {
    await this.locked(ticket.bindingId, async client => {
      // The ticket's row, as read (a Date has millisecond precision): nothing
      // moves a reclaiming row, so only this reclamation's own callback matches.
      const result = await client.query(`UPDATE delegation_environments SET sandbox_id=NULL, creating_since=NULL, reclaiming=FALSE
        WHERE id=$1 AND reclaiming=TRUE AND sandbox_id IS NOT DISTINCT FROM $2
          AND date_trunc('milliseconds', creating_since) IS NOT DISTINCT FROM $3::timestamptz RETURNING id`,
      [ticket.bindingId, ticket.sandboxId, ticket.creatingSince]);
      if (result.rows.length) await client.query(`DELETE FROM delegation_resource_uses u USING sessions s
        WHERE s.id=u.record->>'sessionId' AND s.status='terminated' AND u.record->>'sandboxSessionId'=$1`, [ticket.bindingId]);
    });
  }
  /**
   * One autocommitted statement over the bindings' rows; it inserts no row,
   * so a binding without one stays absent. In use means a pending event of a
   * non-terminated Session of the binding (a Child shares its root's), or a
   * resource use whose input is still pending. Unlike claimReclamation, a use
   * left after its input was acknowledged does not count: it records a Turn
   * that ended with an uncertain execution, and ADR-0023 pauses that Sandbox
   * 30 minutes after the sweeper finds it, as any idle one.
   */
  async sweepFacts(bindingIds: readonly string[]): Promise<SandboxSweepFacts> {
    const ids = [...new Set(bindingIds)];
    // A list of parameters rather than = ANY($1): pg-mem, which runs this
    // store's tests without a server, matches no row with ANY.
    const listed = ids.length ? ids.map((_, i) => `$${i + 1}`).join(", ") : "NULL";
    const { rows } = await this.pool.query<{ id: string | null; sandbox_id: string | null; creating_since: Date | null; reclaiming: boolean;
      in_use: boolean; all_sessions_terminated: boolean; now: Date }>(
      `WITH alive AS (
         SELECT s.id, COALESCE(s.delegation->>'sandboxSessionId', s.id) AS binding_id FROM sessions s
         WHERE s.status <> 'terminated' AND COALESCE(s.delegation->>'sandboxSessionId', s.id) IN (${listed})
       ), in_use AS (
         SELECT u.record->>'sandboxSessionId' AS binding_id FROM delegation_resource_uses u JOIN sessions s ON s.id = u.record->>'sessionId'
           JOIN pending_events pu ON pu.id = u.record->>'pendingEventId'
         WHERE u.record->>'sandboxSessionId' IN (${listed}) AND s.status <> 'terminated'
         UNION SELECT a.binding_id FROM pending_events p JOIN alive a ON a.id = p.session_id
       ), found AS (
         SELECT e.id, e.sandbox_id, e.creating_since, e.reclaiming,
           i.binding_id IS NOT NULL AS in_use, l.binding_id IS NULL AS all_sessions_terminated
         FROM delegation_environments e
         LEFT JOIN in_use i ON i.binding_id = e.id
         LEFT JOIN (SELECT DISTINCT binding_id FROM alive) l ON l.binding_id = e.id
         WHERE e.id IN (${listed})
       )
       -- One row even when no binding has one: it carries the clock.
       SELECT f.*, clock.now FROM (SELECT now() AS now) clock LEFT JOIN found f ON TRUE`, ids);
    return {
      now: rows[0].now,
      bindings: new Map(rows.flatMap((row) => row.id === null ? [] : [[row.id, {
        sandboxId: row.sandbox_id, creatingSince: row.creating_since, reclaiming: row.reclaiming,
        inUse: row.in_use, allSessionsTerminated: row.all_sessions_terminated,
      }] as const])),
    };
  }
}
