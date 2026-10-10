import type { Pool, PoolClient } from './connection.js';
import type { SandboxActivity, SandboxLifecycleStore, SandboxReclamation } from '../interfaces/sandbox-lifecycle-store.js';

/** Coordinates business execution and explicit termination. No idle scanner or resource clock. */
export class PgSandboxLifecycleStore implements SandboxLifecycleStore {
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
      const { rows: [row] } = await client.query<{ sandbox_id: string | null; reclaiming: boolean }>('SELECT sandbox_id, reclaiming FROM delegation_environments WHERE id=$1', [bindingId]);
      if (!row.sandbox_id) return null;
      if (row.reclaiming) return { bindingId, sandboxId: row.sandbox_id };
      const busy = await client.query(`SELECT 1 FROM delegation_resource_uses u JOIN sessions s ON s.id=u.record->>'sessionId'
        WHERE u.record->>'sandboxSessionId'=$1 AND s.status <> 'terminated'
        UNION ALL SELECT 1 FROM pending_events p JOIN sessions s ON s.id=p.session_id
        WHERE COALESCE(s.delegation->>'sandboxSessionId',s.id)=$1 AND s.status <> 'terminated' LIMIT 1`, [bindingId]);
      if (busy.rows.length) return null;
      await client.query('UPDATE delegation_environments SET reclaiming=TRUE WHERE id=$1', [bindingId]);
      return { bindingId, sandboxId: row.sandbox_id };
    });
  }
  async completeReclamation(ticket: SandboxReclamation): Promise<void> {
    await this.locked(ticket.bindingId, async client => {
      const result = await client.query('UPDATE delegation_environments SET sandbox_id=NULL, reclaiming=FALSE WHERE id=$1 AND sandbox_id=$2 AND reclaiming=TRUE RETURNING id', [ticket.bindingId, ticket.sandboxId]);
      if (result.rows.length) await client.query(`DELETE FROM delegation_resource_uses u USING sessions s
        WHERE s.id=u.record->>'sessionId' AND s.status='terminated' AND u.record->>'sandboxSessionId'=$1`, [ticket.bindingId]);
    });
  }
}
