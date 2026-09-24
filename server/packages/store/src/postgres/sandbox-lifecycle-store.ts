import type { Pool, PoolClient } from './connection.js';
import { SANDBOX_IDLE_MS, type SandboxActivity, type SandboxLifecycleStore, type SandboxReclamation } from '../interfaces/sandbox-lifecycle-store.js';

/** Tracks all Sandbox use and only reclaims resources after observed idle time. */
export class PgSandboxLifecycleStore implements SandboxLifecycleStore {
  constructor(private readonly pool: Pool, private readonly clock?: () => Date) {}
  async assertReady(): Promise<void> {
    const result = await this.pool.query("SELECT 1 FROM pg_trigger WHERE tgname = 'sandbox_input_activity' AND tgrelid = 'pending_events'::regclass AND tgfoid = 'invalidate_sandbox_idle()'::regprocedure AND tgenabled IN ('O', 'A')");
    if (!result.rows.length) throw new Error('Sandbox lifecycle requires migration 0014 and its input activity trigger');
  }
  async markAllManaged(): Promise<void> {
    await this.pool.query('UPDATE delegation_environments SET lifecycle_managed=TRUE, idle_since=NULL WHERE lifecycle_managed=FALSE');
  }

  async listManagedBindings(): Promise<readonly string[]> {
    // File access can create a binding without starting a Turn. Include those
    // bindings on the next sweep as well as those present at Runner startup.
    await this.markAllManaged();
    const result = await this.pool.query<{ id: string }>(
      'SELECT id FROM delegation_environments WHERE lifecycle_managed=TRUE AND sandbox_id IS NOT NULL ORDER BY id',
    );
    return result.rows.map(row => row.id);
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

  async begin(activity: SandboxActivity, managed = true): Promise<boolean> {
    return this.locked(activity.bindingId, async client => {
      const { rows: [environment] } = await client.query<{ reclaiming: boolean }>('SELECT reclaiming FROM delegation_environments WHERE id = $1', [activity.bindingId]);
      if (environment.reclaiming) return false;
      // Validate ownership in the same transaction as registering an attempt.
      const fence = activity.fence;
      const owned = await client.query(`SELECT p.id FROM pending_events p JOIN sessions s ON s.id=p.session_id
        WHERE p.session_id=$1 AND p.id=$2 AND p.claim_owner=$3 AND p.claim_generation=$4
          AND p.claim_expires_at > clock_timestamp() AND s.status <> 'terminated'
          AND COALESCE(s.delegation->>'sandboxSessionId',s.id)=$5`, [activity.sessionId, fence.eventId, fence.ownerId, fence.generation, activity.bindingId]);
      if (!owned.rows.length) throw new Error('Cannot protect Sandbox for a stale Turn owner');
      await client.query('UPDATE delegation_environments SET lifecycle_managed = lifecycle_managed OR $2, idle_since = NULL WHERE id = $1', [activity.bindingId, managed]);
      await client.query('INSERT INTO sandbox_activities (id, binding_id, session_id, pending_event_id, owner_id, generation) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [activityKey(activity), activity.bindingId, activity.sessionId, fence.eventId, fence.ownerId, fence.generation]);
      return true;
    });
  }

  async finish(activity: SandboxActivity): Promise<void> {
    await this.locked(activity.bindingId, async client => {
      const removed = await client.query('DELETE FROM sandbox_activities WHERE id = $1 RETURNING id', [activityKey(activity)]);
      // Duplicate/delayed callbacks must not reset another generation's clock.
      if (removed.rows.length) await client.query('UPDATE delegation_environments SET idle_since = NULL WHERE id = $1', [activity.bindingId]);
    });
  }

  async claimReclamation(bindingId: string, explicit = false): Promise<SandboxReclamation | null> {
    return this.locked(bindingId, async client => {
      const { rows: [row] } = await client.query<{ sandbox_id: string | null; lifecycle_managed: boolean; reclaiming: boolean; idle_since: Date | null; now: Date }>('SELECT sandbox_id, lifecycle_managed, reclaiming, idle_since, clock_timestamp() AS now FROM delegation_environments WHERE id = $1', [bindingId]);
      const now = this.clock?.() ?? new Date(row.now);
      if (!row.lifecycle_managed || !row.sandbox_id) return null;
      // A committed deletion ticket fences all future execution until cleanup.
      // A retry after Host death repeats only the idempotent deletion of this ID.
      if (row.reclaiming) return { bindingId, sandboxId: row.sandbox_id };
      const busy = await client.query(`SELECT 1 FROM sandbox_activities WHERE binding_id = $1
        UNION ALL SELECT 1 FROM pending_events p JOIN sessions s ON s.id = p.session_id
        WHERE COALESCE(s.delegation->>'sandboxSessionId', s.id) = $1 LIMIT 1`, [bindingId]);
      if (busy.rows.length) {
        await client.query('UPDATE delegation_environments SET idle_since = NULL WHERE id = $1', [bindingId]);
        return null;
      }
      if (!explicit && !row.idle_since) {
        await client.query('UPDATE delegation_environments SET idle_since = $2 WHERE id = $1', [bindingId, now]);
        return null;
      }
      if (!explicit && now.getTime() - new Date(row.idle_since!).getTime() < SANDBOX_IDLE_MS) return null;
      await client.query('UPDATE delegation_environments SET reclaiming = TRUE WHERE id = $1', [bindingId]);
      return { bindingId, sandboxId: row.sandbox_id };
    });
  }

  async completeReclamation(ticket: SandboxReclamation): Promise<void> {
    await this.locked(ticket.bindingId, async client => {
      await client.query('UPDATE delegation_environments SET sandbox_id = NULL, idle_since = NULL, reclaiming = FALSE WHERE id = $1 AND sandbox_id = $2 AND reclaiming = TRUE', [ticket.bindingId, ticket.sandboxId]);
    });
  }
}

function activityKey(activity: SandboxActivity): string {
  return JSON.stringify([activity.bindingId, activity.sessionId, activity.fence.eventId, activity.fence.ownerId, activity.fence.generation]);
}
