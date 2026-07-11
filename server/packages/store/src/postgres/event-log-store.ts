import type { Pool, PoolClient } from "./connection.js";
import type { EventLogIngressStore, EventLogStoreAppendInput, EventLogStoreGetEventsOpts } from "../interfaces/event-log-store.js";
import type { PaginatedResult, StoredEvent } from "../types.js";
import { PendingEventClaimLostError } from "../errors.js";

interface EventRow {
  session_id: string;
  seq: string | number;
  type: string;
  data: unknown;
  ts: Date;
  session_thread_id: string;
  idempotency_key: string | null;
}

function rowToEvent(row: EventRow): StoredEvent {
  return {
    sessionId: row.session_id,
    seq: Number(row.seq),
    type: row.type,
    data: row.data,
    ts: new Date(row.ts),
    sessionThreadId: row.session_thread_id,
  };
}

export class PgEventLogStore implements EventLogIngressStore {
  constructor(private readonly pool: Pool) {}

  private async assertLiveFence(
    client: PoolClient,
    sessionId: string,
    fence: NonNullable<EventLogStoreAppendInput["pendingFence"]>,
  ): Promise<void> {
    // Lock first, then evaluate status/lease. PostgreSQL may evaluate predicates
    // before a lock wait; the second reads below observe state and wall clock
    // only after the locks are held. Session-first matches terminate()'s order.
    const session = await client.query<{ status: string }>(
      `SELECT status FROM sessions WHERE id = $1 FOR UPDATE`,
      [sessionId],
    );
    if (!session.rows[0] || session.rows[0].status === "terminated") {
      throw new PendingEventClaimLostError(
        sessionId,
        fence.eventId,
        fence.ownerId,
        fence.generation,
      );
    }
    const locked = await client.query<{ id: string }>(
      `SELECT id FROM pending_events
       WHERE session_id = $1 AND id = $2
       FOR UPDATE`,
      [sessionId, fence.eventId],
    );
    if (!locked.rows[0]) {
      throw new PendingEventClaimLostError(
        sessionId,
        fence.eventId,
        fence.ownerId,
        fence.generation,
      );
    }
    const live = await client.query<{ id: string }>(
      `SELECT id FROM pending_events
       WHERE session_id = $1
         AND id = $2
         AND claim_owner = $3
         AND claim_generation = $4
         AND claim_expires_at > clock_timestamp()`,
      [sessionId, fence.eventId, fence.ownerId, fence.generation],
    );
    if (!live.rows[0]) {
      throw new PendingEventClaimLostError(
        sessionId,
        fence.eventId,
        fence.ownerId,
        fence.generation,
      );
    }
  }

  async append(sessionId: string, event: EventLogStoreAppendInput): Promise<StoredEvent> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Fence every turn-owned durable write in the same transaction as the
      // append. FOR UPDATE keeps a claimant from expiring/reassigning midway
      // through this short critical section; a delayed old generation cannot
      // persist output after a new attempt has taken ownership.
      if (event.pendingFence) {
        await this.assertLiveFence(client, sessionId, event.pendingFence);
      }

      // Ensure then lock the per-Session counter row. This serializes all
      // appends for one Session, including concurrent retries of one
      // idempotency key, without blocking unrelated Sessions.
      await client.query(
        `INSERT INTO event_counters (session_id, seq) VALUES ($1, 0)
         ON CONFLICT (session_id) DO NOTHING`,
        [sessionId],
      );
      await client.query(
        `SELECT seq FROM event_counters WHERE session_id = $1 FOR UPDATE`,
        [sessionId],
      );

      // A retry after an ambiguous commit returns the original Event. The
      // counter lock makes this check race-free even when several retries arrive
      // concurrently for a key that has not existed before.
      if (event.idempotencyKey !== undefined) {
        const existing = await client.query<EventRow>(
          `SELECT * FROM events WHERE session_id = $1 AND idempotency_key = $2`,
          [sessionId, event.idempotencyKey],
        );
        if (existing.rows[0]) {
          await client.query("COMMIT");
          return rowToEvent(existing.rows[0]);
        }
      }

      const counter = await client.query<{ seq: string | number }>(
        `UPDATE event_counters SET seq = seq + 1 WHERE session_id = $1 RETURNING seq`,
        [sessionId],
      );
      const seq = Number(counter.rows[0].seq);
      const ts = new Date();

      const { rows } = await client.query<EventRow>(
        `INSERT INTO events (session_id, seq, type, data, ts, session_thread_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          sessionId,
          seq,
          event.type,
          JSON.stringify(event.data ?? null),
          ts,
          event.sessionThreadId,
          event.idempotencyKey ?? null,
        ],
      );

      await client.query("COMMIT");
      return rowToEvent(rows[0]);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (err instanceof PendingEventClaimLostError) throw err;
      // The unique index is the final cross-process arbiter. Real PostgreSQL's
      // counter-row lock normally makes the earlier lookup sufficient, but a
      // concurrent first append (and pg-mem's weaker lock simulation) can still
      // reach the unique constraint. The failed transaction rolled its counter
      // increment back, so return the committed winner without creating a gap.
      const pgError = err as { code?: unknown; constraint?: unknown };
      const isTargetUniqueConflict =
        pgError?.code === "23505" &&
        (
          pgError.constraint === undefined ||
          pgError.constraint === "events_session_idempotency_key_uidx"
        );
      if (event.idempotencyKey !== undefined && isTargetUniqueConflict) {
        try {
          await client.query("BEGIN");
          if (event.pendingFence) {
            await this.assertLiveFence(client, sessionId, event.pendingFence);
          }
          const existing = await client.query<EventRow>(
            `SELECT * FROM events WHERE session_id = $1 AND idempotency_key = $2`,
            [sessionId, event.idempotencyKey],
          );
          await client.query("COMMIT");
          if (existing.rows[0]) return rowToEvent(existing.rows[0]);
        } catch (recoveryError) {
          await client.query("ROLLBACK").catch(() => {});
          throw recoveryError;
        }
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async appendIfSessionActive(
    sessionId: string,
    event: Pick<EventLogStoreAppendInput, "type" | "data" | "sessionThreadId">,
  ): Promise<StoredEvent | null> {
    const serializedData = JSON.stringify(event.data ?? null);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const active = await client.query<{ status: string }>(
        `SELECT status FROM sessions WHERE id = $1 FOR UPDATE`,
        [sessionId],
      );
      if (!active.rows[0] || active.rows[0].status === "terminated") {
        await client.query("COMMIT");
        return null;
      }

      await client.query(
        `INSERT INTO event_counters (session_id, seq) VALUES ($1, 0)
         ON CONFLICT (session_id) DO NOTHING`,
        [sessionId],
      );
      await client.query(
        `SELECT seq FROM event_counters WHERE session_id = $1 FOR UPDATE`,
        [sessionId],
      );
      const counter = await client.query<{ seq: string | number }>(
        `UPDATE event_counters SET seq = seq + 1 WHERE session_id = $1 RETURNING seq`,
        [sessionId],
      );
      const seq = Number(counter.rows[0].seq);
      const { rows } = await client.query<EventRow>(
        `INSERT INTO events (session_id, seq, type, data, ts, session_thread_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, NULL)
         RETURNING *`,
        [sessionId, seq, event.type, serializedData, new Date(), event.sessionThreadId],
      );
      await client.query("COMMIT");
      return rowToEvent(rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async getEvents(sessionId: string, opts?: EventLogStoreGetEventsOpts): Promise<PaginatedResult<StoredEvent>> {
    const limit = opts?.limit ?? 50;
    const params: unknown[] = [sessionId];
    let where = `session_id = $1`;
    if (opts?.afterSeq !== undefined) {
      params.push(opts.afterSeq);
      where += ` AND seq > $${params.length}`;
    }
    params.push(limit + 1);
    const { rows } = await this.pool.query<EventRow>(
      `SELECT * FROM events WHERE ${where} ORDER BY seq ASC LIMIT $${params.length}`,
      params,
    );

    const hasMore = rows.length > limit;
    const data = (hasMore ? rows.slice(0, limit) : rows).map(rowToEvent);
    return { data, hasMore };
  }
}
