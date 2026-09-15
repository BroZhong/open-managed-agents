import type { Pool, PoolClient } from "./connection.js";
import { PgSessionStore } from "./session-store.js";
import { PgPendingEventStore } from "./pending-event-store.js";
import { TransactionalDelegationStore, delegationFenceLost, type DelegationTransaction, type DelegationTable, type DelegationRecord } from "../delegation-store.js";
import type { EventLogStoreAppendInput } from "../interfaces/event-log-store.js";
import type { DelegationExecution, DelegationCommand, DelegationWait } from "../interfaces/delegation-store.js";
import type { StoredEvent } from "../types.js";

const tables: Record<DelegationTable, string> = { executions: "delegation_executions", waits: "delegation_waits", commands: "delegation_commands", resource_uses: "delegation_resource_uses" };
/** All writes use the same SQL transaction as existing Sessions and event queues. */
export class PgDelegationStore extends TransactionalDelegationStore {
  constructor(private readonly pool: Pool) { super(); }
  protected override async terminatedExecutionIds(sessionId: string | undefined, limit: number): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(`SELECT execution.id FROM delegation_executions execution
      JOIN sessions child ON child.id = execution.record->>'childId'
      JOIN sessions parent ON parent.id = execution.record->>'callerSessionId'
      WHERE execution.record->>'status' IN ('queued', 'running')
        AND (child.status = 'terminated' OR (parent.status = 'terminated' AND execution.record->>'mode' = 'sync'
          AND COALESCE(execution.record->>'parentTerminationRequested', 'false') <> 'true'))
        ${sessionId ? "AND (child.id = $2 OR parent.id = $2)" : ""}
      ORDER BY execution.id LIMIT $1`, [limit, ...(sessionId ? [sessionId] : [])]);
    return result.rows.map((row) => row.id);
  }
  protected override async terminatedParentWaits(sessionId: string | undefined, limit: number): Promise<DelegationWait[]> {
    const result = await this.pool.query<{ record: DelegationWait }>(`SELECT waiting.record FROM delegation_waits waiting
      JOIN sessions parent ON parent.id = waiting.record->>'callerSessionId'
      WHERE waiting.record->>'status' = 'waiting' AND parent.status = 'terminated'
        ${sessionId ? "AND parent.id = $2" : ""} ORDER BY waiting.id LIMIT $1`, [limit, ...(sessionId ? [sessionId] : [])]);
    return result.rows.map((row) => row.record);
  }
  override async getChild(tenantId: string, childId: string) {
    const session = await new PgSessionStore(this.pool).getById(childId);
    return session?.tenantId === tenantId && session.delegation ? session : null;
  }
  override async getExecution(tenantId: string, executionId: string) {
    const result = await this.pool.query<{ record: DelegationExecution }>("SELECT record FROM delegation_executions WHERE id = $1 AND record->>'tenantId' = $2", [executionId, tenantId]);
    return result.rows[0]?.record ?? null;
  }
  override async getByPendingEventId(pendingEventId: string) {
    const result = await this.pool.query<{ record: DelegationExecution }>("SELECT record FROM delegation_executions WHERE record->>'pendingEventId' = $1", [pendingEventId]);
    return result.rows[0]?.record ?? null;
  }
  override async listExecutions(tenantId: string, opts: { callerSessionId?: string; callerTurnId?: string; callerToolUseId?: string; childId?: string; limit?: number; afterId?: string }) {
    const params: unknown[] = [tenantId];
    const where = ["record->>'tenantId' = $1"];
    for (const key of ["callerSessionId", "callerTurnId", "callerToolUseId", "childId"] as const) {
      if (opts[key]) { params.push(opts[key]); where.push(`record->>'${key}' = $${params.length}`); }
    }
    if (opts.afterId) {
      const cursor = await this.pool.query<{ record: DelegationExecution }>(`SELECT record FROM delegation_executions WHERE ${where.join(" AND ")} AND id = $${params.length + 1}`, [...params, opts.afterId]);
      if (!cursor.rows[0]) return [];
      params.push(cursor.rows[0].record.createdAt, opts.afterId);
      where.push(`(record->>'createdAt' < $${params.length - 1} OR (record->>'createdAt' = $${params.length - 1} AND id < $${params.length}))`);
    }
    params.push(Math.min(Math.max(opts.limit ?? 100, 1), 500));
    const result = await this.pool.query<{ record: DelegationExecution }>(`SELECT record FROM delegation_executions WHERE ${where.join(" AND ")} ORDER BY record->>'createdAt' DESC, id DESC LIMIT $${params.length}`, params);
    return result.rows.map((row) => row.record);
  }
  override async get(tenantId: string, callerSessionId: string, childId: string, executionId?: string) {
    const child = await this.getChild(tenantId, childId);
    if (!child || child.delegation?.parentSessionId !== callerSessionId && childId !== callerSessionId) return null;
    const result = await this.pool.query<{ record: DelegationExecution }>(`SELECT record FROM delegation_executions WHERE record->>'tenantId' = $1 AND record->>'childId' = $2${executionId ? " AND id = $3" : ""} ORDER BY (record->>'sequence')::INTEGER DESC LIMIT 1`, [tenantId, childId, ...(executionId ? [executionId] : [])]);
    return result.rows[0]?.record ?? null;
  }
  override async listCommands(executionId: string) {
    const result = await this.pool.query<{ record: DelegationCommand }>("SELECT record FROM delegation_commands WHERE record->>'executionId' = $1 ORDER BY record->>'createdAt', id", [executionId]);
    return result.rows.map((row) => row.record);
  }
  override async listWaits(parentSessionId: string, parentPendingEventId: string) {
    const result = await this.pool.query<{ record: DelegationWait }>("SELECT record FROM delegation_waits WHERE record->>'callerSessionId' = $1 AND record->>'parentPendingEventId' = $2", [parentSessionId, parentPendingEventId]);
    return result.rows.map((row) => row.record);
  }
  protected async transaction<T>(work: (tx: DelegationTransaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // A row lock works on all supported PostgreSQL versions and orders quota
      // admission, acceptance idempotency, terminal publication and consumption.
      await client.query("SELECT id FROM delegation_lock WHERE id = 'coordination' FOR UPDATE");
      // These methods use only .query(), never start a nested transaction.
      const queryPool = client as unknown as Pool;
      const sessions = new PgSessionStore(queryPool);
      const pending = new PgPendingEventStore(queryPool);
      pending.ownsClaim = async (sessionId, eventId, fence) => {
        const result = await client.query("SELECT id FROM pending_events WHERE session_id = $1 AND id = $2 AND claim_owner = $3 AND claim_generation = $4 AND claim_expires_at > clock_timestamp()", [sessionId, eventId, fence.ownerId, fence.generation]);
        return result.rows.length > 0;
      };
      const tx: DelegationTransaction = {
        sessions: {
          create: (input) => sessions.create(input),
          getById: async (id) => { await client.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [id]); return sessions.getById(id); },
        },
        pending,
        read: async <R extends DelegationRecord>(table: DelegationTable, filters: Record<string, string> = {}) => {
          const params: unknown[] = [];
          const predicates = Object.entries(filters).map(([key, value]) => { params.push(key, value); return `record ->> $${params.length - 1} = $${params.length}`; });
          const rows = await client.query<{ record: R }>(`SELECT record FROM ${tables[table]}${predicates.length ? ` WHERE ${predicates.join(" AND ")}` : ""}`, params);
          return rows.rows.map((row) => row.record);
        },
        put: async (table, id, record) => { await client.query(`INSERT INTO ${tables[table]} (id, record) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET record = EXCLUDED.record`, [id, JSON.stringify(record)]); },
        remove: async (table, id) => { await client.query(`DELETE FROM ${tables[table]} WHERE id = $1`, [id]); },
        removePending: async (sessionId, eventId, onlyUnclaimed) => {
          const rows = await client.query(`DELETE FROM pending_events WHERE session_id = $1 AND id = $2${onlyUnclaimed ? " AND (claim_owner IS NULL OR claim_expires_at <= clock_timestamp())" : ""}`, [sessionId, eventId]);
          return Boolean(rows.rowCount);
        },
        append: (sessionId, input) => this.append(client, sessionId, input),
        assertFence: async (sessionId, fence) => {
          await client.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [sessionId]);
          await client.query("SELECT id FROM pending_events WHERE session_id = $1 AND id = $2 FOR UPDATE", [sessionId, fence.eventId]);
          const session = await sessions.getById(sessionId);
          if (!session || session.status === "terminated" || !await pending.ownsClaim(sessionId, fence.eventId, fence)) delegationFenceLost(sessionId, fence);
        },
      };
      const result = await work(tx);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  /** Append while retaining the caller's open transaction and Session locks. */
  private async append(client: PoolClient, sessionId: string, input: EventLogStoreAppendInput): Promise<StoredEvent> {
    await client.query("INSERT INTO event_counters (session_id, seq) VALUES ($1, 0) ON CONFLICT (session_id) DO NOTHING", [sessionId]);
    await client.query("SELECT seq FROM event_counters WHERE session_id = $1 FOR UPDATE", [sessionId]);
    if (input.idempotencyKey) {
      const existing = await client.query("SELECT * FROM events WHERE session_id = $1 AND idempotency_key = $2", [sessionId, input.idempotencyKey]);
      if (existing.rows[0]) { const row = existing.rows[0]; return { sessionId, seq: Number(row.seq), type: row.type, data: row.data, ts: new Date(row.ts), sessionThreadId: row.session_thread_id }; }
    }
    const counter = await client.query("UPDATE event_counters SET seq = seq + 1 WHERE session_id = $1 RETURNING seq", [sessionId]);
    const seq = Number(counter.rows[0].seq);
    const ts = new Date();
    await client.query("INSERT INTO events (session_id, seq, type, data, ts, session_thread_id, api_key_id, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [sessionId, seq, input.type, JSON.stringify(input.data ?? null), ts, input.sessionThreadId, input.apiKeyId ?? null, input.idempotencyKey ?? null]);
    return { sessionId, seq, type: input.type, data: input.data, ts, sessionThreadId: input.sessionThreadId };
  }
  async withEnvironmentLock<T>(bindingId: string, work: (sandboxId: string | null) => Promise<{ sandboxId: string | null; value: T }>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO delegation_environments (id, sandbox_id) VALUES ($1, NULL) ON CONFLICT (id) DO NOTHING", [bindingId]);
      const row = await client.query<{ sandbox_id: string | null }>("SELECT sandbox_id FROM delegation_environments WHERE id = $1 FOR UPDATE", [bindingId]);
      const result = await work(row.rows[0].sandbox_id);
      await client.query("UPDATE delegation_environments SET sandbox_id = $2 WHERE id = $1", [bindingId, result.sandboxId]);
      await client.query("COMMIT");
      return result.value;
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
  }
}
