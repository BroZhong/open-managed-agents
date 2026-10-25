import { EventPayloadCodec } from "../event-payload.js";
import { eventSequenceWidth } from "../event-presentation.js";
import type { Pool, PoolClient } from "./connection.js";
import { PgSessionStore } from "./session-store.js";
import { PgPendingEventStore } from "./pending-event-store.js";
import { TransactionalDelegationStore, delegationFenceLost, type DelegationTransaction, type DelegationTable, type DelegationRecord, type SandboxBindingRecord } from "../delegation-store.js";
import type { EventLogStoreAppendInput } from "../interfaces/event-log-store.js";
import type { DelegationExecution, DelegationCommand, DelegationWait, SandboxBindingRow, BindingLockResult, BindingTransition, InstalledSkillSet, SkillSetRecordOutcome } from "../interfaces/delegation-store.js";
import type { StoredEvent } from "../types.js";
import { SandboxBindingChanged } from "../errors.js";
import type { PendingEventFence } from "../interfaces/pending-event-store.js";

const tables: Record<DelegationTable, string> = { executions: "delegation_executions", waits: "delegation_waits", commands: "delegation_commands", resource_uses: "delegation_resource_uses" };
type BindingRow = { sandbox_id: string | null; reclaiming: boolean; creating_since: Date | null; last_error_code: string | null; now: Date };
/** The row as compared: both reads come back as Dates of millisecond precision. */
const sameRow = (a: BindingRow, b: BindingRow) =>
  a.sandbox_id === b.sandbox_id && (a.creating_since?.getTime() ?? null) === (b.creating_since?.getTime() ?? null);
/** `sandbox_id`, and whether `creating_since` becomes the transaction's now(). */
const written = (next: BindingTransition): [string | null, boolean] =>
  next === "cold" ? [null, false] : next === "creating" ? [null, true] : [next.ready, false];
/** All writes use the same SQL transaction as existing Sessions and event queues. */
export class PgDelegationStore extends TransactionalDelegationStore {
  private readonly bindingQueues = new Map<string, Promise<void>>();
  constructor(private readonly pool: Pool, private readonly payloads?: EventPayloadCodec) { super(); }
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
      const checkedFences = new Map<string, PendingEventFence>();
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
          const predicates = Object.entries(filters).map(([key, value]) => {
            // Executions and commands are stored under their own id: use the key, not a record scan.
            if (key === "id" && (table === "executions" || table === "commands")) { params.push(value); return `id = $${params.length}`; }
            params.push(key, value); return `record ->> $${params.length - 1} = $${params.length}`;
          });
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
        assertWorkspaceNotDeleted: async (tenantId, workspaceId) => {
          // Order new child creation against softDelete's UPDATE. Existing inputs
          // and resumes never take this gate: soft deletion does not end execution.
          const result = await client.query<{ deleted_at: Date | null }>(
            "SELECT deleted_at FROM workspaces WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
            [tenantId, workspaceId],
          );
          if (result.rows[0]?.deleted_at) throw new Error("Workspace has been deleted");
        },
        assertFence: async (sessionId, fence) => {
          await client.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [sessionId]);
          await client.query("SELECT id FROM pending_events WHERE session_id = $1 AND id = $2 FOR UPDATE", [sessionId, fence.eventId]);
          const session = await sessions.getById(sessionId);
          if (!session || session.status === "terminated" || !await pending.ownsClaim(sessionId, fence.eventId, fence)) delegationFenceLost(sessionId, fence);
          checkedFences.set(sessionId, fence);
        },
      };
      const result = await work(tx);
      // An OSS upload can outlast a lease while row locks are held. Recheck
      // wall-clock ownership immediately before committing any references.
      for (const [sessionId, fence] of checkedFences) {
        if (!await pending.ownsClaim(sessionId, fence.eventId, fence)) delegationFenceLost(sessionId, fence);
      }
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
      if (existing.rows[0]) { const row = existing.rows[0]; return { sessionId, seq: Number(row.seq), type: row.type, data: this.payloads ? await this.payloads.decode(sessionId, row.data, row.type) : row.data, ts: new Date(row.ts), sessionThreadId: row.session_thread_id }; }
    }
    const data = this.payloads ? await this.payloads.encode(sessionId, input.type, input.data) : input.data;
    const counter = await client.query("UPDATE event_counters SET seq = seq + $2 WHERE session_id = $1 RETURNING seq", [sessionId, eventSequenceWidth(input.type, input.data)]);
    const seq = Number(counter.rows[0].seq);
    const ts = new Date();
    await client.query("INSERT INTO events (session_id, seq, type, data, ts, session_thread_id, api_key_id, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [sessionId, seq, input.type, JSON.stringify(data ?? null), ts, input.sessionThreadId, input.apiKeyId ?? null, input.idempotencyKey ?? null]);
    return { sessionId, seq, type: input.type, data: input.data, ts, sessionThreadId: input.sessionThreadId };
  }
  /**
   * `work` performs Sandbox control-plane I/O and itself queries this pool, so it
   * must never run while a pooled client is checked out: N concurrent holders
   * waiting for an N+1th client deadlock the pool permanently. Same-process
   * callers are serialized in memory; the durable row is read and then
   * compare-and-set in two short transactions, so a concurrent writer (another
   * Runner or a reclamation) fails this commit instead of being overwritten.
   */
  async withBindingLock<T>(bindingId: string, work: (binding: SandboxBindingRow) => Promise<BindingLockResult<T>>): Promise<T> {
    const previous = this.bindingQueues.get(bindingId) ?? Promise.resolve();
    const current = previous.then(() => this.bindingOperation(bindingId, work));
    const settled = current.then(() => {}, () => {});
    this.bindingQueues.set(bindingId, settled);
    void settled.then(() => { if (this.bindingQueues.get(bindingId) === settled) this.bindingQueues.delete(bindingId); });
    return current;
  }
  /**
   * The intent is written with the database clock: `creating_since` is the
   * compare-and-set transaction's now(), and `now` the snapshot's, so every
   * Runner judges a deadline against the same clock (ADR-0023).
   */
  private async bindingOperation<T>(bindingId: string, work: (binding: SandboxBindingRow) => Promise<BindingLockResult<T>>): Promise<T> {
    const snapshot = await this.bindingTransaction(bindingId, async (_client, row) => row);
    const result = await work({ sandboxId: snapshot.sandbox_id, creatingSince: snapshot.creating_since, now: snapshot.now });
    return this.bindingTransaction(bindingId, async (client, row) => {
      if (!sameRow(row, snapshot)) throw new SandboxBindingChanged(bindingId);
      let failed = row.last_error_code !== null;
      if (result.next) {
        const [sandboxId, creating] = written(result.next);
        // A move begins a new state: its time, and none of the old state's failure.
        await client.query(`UPDATE delegation_environments SET sandbox_id = $2, creating_since = CASE WHEN $3::boolean THEN now() END,
          state_since = now(), last_error_code = NULL, last_error_reason = NULL, last_error_at = NULL WHERE id = $1`,
        [bindingId, sandboxId, creating]);
        failed = false;
      }
      const observed = result.observed;
      // A ready observation ends unavailability; with no failure recorded it writes nothing.
      if (observed === "ready") {
        if (failed) await client.query(`UPDATE delegation_environments SET state_since = now(),
          last_error_code = NULL, last_error_reason = NULL, last_error_at = NULL WHERE id = $1`, [bindingId]);
      } else if (observed) {
        // The latest failure is reported; unavailability began with the first.
        await client.query(`UPDATE delegation_environments SET last_error_code = $2, last_error_reason = $3, last_error_at = now(),
          state_since = CASE WHEN $4::boolean THEN state_since ELSE now() END WHERE id = $1`,
        [bindingId, observed.failure.code, observed.failure.reason, failed]);
      }
      return result.value;
    });
  }
  /** Autocommitted, without the row lock: a reclaiming binding reads too. */
  protected async bindingRecord(bindingId: string): Promise<SandboxBindingRecord | undefined> {
    const { rows: [row] } = await this.pool.query<{ sandbox_id: string | null; creating_since: Date | null; state_since: Date | null;
      last_error_code: string | null; last_error_reason: string | null; last_error_at: Date | null }>(
      `SELECT sandbox_id, creating_since, state_since, last_error_code, last_error_reason, last_error_at
       FROM delegation_environments WHERE id = $1`, [bindingId]);
    if (!row) return undefined;
    return {
      sandboxId: row.sandbox_id, creatingSince: row.creating_since, stateSince: row.state_since,
      lastError: row.last_error_code !== null && row.last_error_at !== null
        ? { code: row.last_error_code, reason: row.last_error_reason ?? "", at: row.last_error_at } : null,
    };
  }
  async installedSkillSet(bindingId: string): Promise<InstalledSkillSet | null> {
    const { rows: [row] } = await this.pool.query<{ skills_sandbox_id: string | null; skills_set_hash: string | null; skills_generation: string | null }>(
      "SELECT skills_sandbox_id, skills_set_hash, skills_generation FROM delegation_environments WHERE id = $1", [bindingId]);
    return row?.skills_sandbox_id && row.skills_set_hash && row.skills_generation !== null
      ? { sandboxId: row.skills_sandbox_id, setHash: row.skills_set_hash, generation: Number(row.skills_generation) } : null;
  }
  /**
   * Autocommitted statements: the Skill Install they record ran with no
   * client or lock held. One compare-and-set; only when it did not apply does
   * a read tell a superseded record from a detached one.
   */
  async recordSkillSetInstall(bindingId: string, installed: InstalledSkillSet): Promise<SkillSetRecordOutcome> {
    const result = await this.pool.query(
      `UPDATE delegation_environments SET skills_sandbox_id = $2, skills_set_hash = $3, skills_generation = $4
       WHERE id = $1 AND sandbox_id = $2 AND reclaiming = FALSE
         AND (skills_sandbox_id IS NULL OR skills_sandbox_id <> $2 OR skills_generation IS NULL OR skills_generation < $4)`,
      [bindingId, installed.sandboxId, installed.setHash, installed.generation]);
    if ((result.rowCount ?? 0) > 0) return "recorded";
    const { rows: [row] } = await this.pool.query<{ sandbox_id: string | null; reclaiming: boolean }>(
      "SELECT sandbox_id, reclaiming FROM delegation_environments WHERE id = $1", [bindingId]);
    return row?.sandbox_id === installed.sandboxId && !row.reclaiming ? "superseded" : "detached";
  }
  /** A short transaction holding the binding row lock; `work` may use only `client`. */
  private async bindingTransaction<T>(bindingId: string, work: (client: PoolClient, row: BindingRow) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO delegation_environments (id, sandbox_id) VALUES ($1, NULL) ON CONFLICT (id) DO NOTHING", [bindingId]);
      const row = await client.query<BindingRow>("SELECT sandbox_id, reclaiming, creating_since, last_error_code, now() AS now FROM delegation_environments WHERE id = $1 FOR UPDATE", [bindingId]);
      if (row.rows[0].reclaiming) throw new Error('Sandbox reclamation in progress; retry input');
      const result = await work(client, row.rows[0]);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
  }
}
