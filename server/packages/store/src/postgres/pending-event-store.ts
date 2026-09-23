import { nanoid } from "nanoid";
import type { StoredEvent } from "../types.js";
import type { Pool } from "./connection.js";
import type {
  PendingEvent,
  PendingEventClaim,
  PendingEventClaimRef,
  PendingEventEnqueueInput,
  PendingEventIngressStore,
} from "../interfaces/pending-event-store.js";

interface PendingRow {
  id: string;
  session_id: string;
  type: string;
  data: unknown;
  session_thread_id: string;
  api_key_id: string | null;
  arrived_at: Date;
  claim_owner?: string | null;
  claim_expires_at?: Date | null;
  claim_generation?: string | number;
}

function rowToEvent(row: PendingRow): PendingEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    type: row.type,
    data: row.data,
    sessionThreadId: row.session_thread_id,
    ...(row.api_key_id ? { apiKeyId: row.api_key_id } : {}),
    arrivedAt: new Date(row.arrived_at),
  };
}

export class PgPendingEventStore implements PendingEventIngressStore {
  constructor(private readonly pool: Pool) {}

  async requestInterrupt(sessionId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE pending_events p SET interrupt_requested_at = COALESCE(interrupt_requested_at, NOW()),
       interrupt_generation = COALESCE(interrupt_generation, claim_generation)
       WHERE p.id = (SELECT id FROM pending_events WHERE session_id = $1
         ORDER BY arrived_at, id LIMIT 1)
       AND p.claim_owner IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM events e WHERE e.session_id = p.session_id
         AND e.type = 'session.turn_completed' AND e.data->>'pendingEventId' = p.id)
       RETURNING p.id`, [sessionId],
    );
    return result.rows.length > 0;
  }

  async interruptRequested(sessionId: string, eventId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM pending_events WHERE session_id = $1 AND id = $2
       AND interrupt_requested_at IS NOT NULL`, [sessionId, eventId],
    );
    return result.rows.length > 0;
  }

  private validateLeaseMs(leaseMs: number): void {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new RangeError("pending event leaseMs must be a positive finite number");
    }
  }

  async enqueue(sessionId: string, event: PendingEventEnqueueInput): Promise<PendingEvent> {
    // Serialize lower-level ingress (including delegation transactions) with
    // completed-input acknowledgement. The aggregate preserves the existing
    // low-level insert behavior even when the Session row is absent.
    const { rows } = await this.pool.query<PendingRow>(
      `INSERT INTO pending_events (id, session_id, type, data, session_thread_id, api_key_id, arrived_at)
       SELECT $1, $2, $3, $4::jsonb, $5, $6, $7::timestamptz
       FROM (SELECT COUNT(*) FROM (SELECT id FROM sessions WHERE id = $2 FOR UPDATE) AS locked_session) AS gate
       RETURNING id, session_id, type, data, session_thread_id, api_key_id, arrived_at`,
      [nanoid(), sessionId, event.type, JSON.stringify(event.data ?? null), event.sessionThreadId, event.apiKeyId ?? null, new Date()],
    );
    return rowToEvent(rows[0]);
  }

  async enqueueBatchIfSessionActive(
    sessionId: string,
    events: PendingEventEnqueueInput[],
  ): Promise<PendingEvent[] | null> {
    // Materialize every fallible value before opening the transaction. Besides
    // failing fast on non-serializable input, this guarantees we never begin a
    // batch whose later item cannot even be encoded.
    const prepared = events.map((event) => ({
      id: nanoid(),
      type: event.type,
      data: JSON.stringify(event.data ?? null),
      sessionThreadId: event.sessionThreadId,
      apiKeyId: event.apiKeyId ?? null,
      arrivedAt: new Date(),
    }));
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Lock the Session row in the same transaction as every INSERT. A
      // concurrent terminate() UPDATE must therefore be ordered either before
      // this batch (we observe terminated and write nothing) or after the batch
      // has committed. It cannot slip between a stale API read and enqueue.
      const active = await client.query<{ status: string }>(
        `SELECT status FROM sessions WHERE id = $1 FOR UPDATE`,
        [sessionId],
      );
      if (!active.rows[0] || active.rows[0].status === "terminated") {
        await client.query("COMMIT");
        return null;
      }

      const inserted: PendingEvent[] = [];
      for (const event of prepared) {
        const { rows } = await client.query<PendingRow>(
          `INSERT INTO pending_events (id, session_id, type, data, session_thread_id, api_key_id, arrived_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, session_id, type, data, session_thread_id, api_key_id, arrived_at`,
          [
            event.id,
            sessionId,
            event.type,
            event.data,
            event.sessionThreadId,
            event.apiKeyId,
            event.arrivedAt,
          ],
        );
        inserted.push(rowToEvent(rows[0]));
      }

      await client.query("COMMIT");
      return inserted;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async dequeue(sessionId: string): Promise<PendingEvent | null> {
    // Legacy-only destructive pop. Lock the FIFO head, then return it only if
    // this transaction actually deleted it. A claimed head cannot be bypassed,
    // and a losing concurrent transaction never returns the winner's row.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const head = await client.query<PendingRow>(
        `SELECT id, session_id, type, data, session_thread_id, api_key_id, arrived_at
         FROM pending_events
         WHERE session_id = $1
         ORDER BY seq ASC
         LIMIT 1
         FOR UPDATE`,
        [sessionId],
      );
      const selected = head.rows[0];
      if (!selected) {
        await client.query("COMMIT");
        return null;
      }
      const deleted = await client.query<{ id: string }>(
        `DELETE FROM pending_events
         WHERE id = $1 AND claim_owner IS NULL
         RETURNING id`,
        [selected.id],
      );
      await client.query("COMMIT");
      return deleted.rows[0] ? rowToEvent(selected) : null;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async peek(sessionId: string): Promise<PendingEvent | null> {
    const { rows } = await this.pool.query<PendingRow>(
      `SELECT id, session_id, type, data, session_thread_id, api_key_id, arrived_at
       FROM pending_events
       WHERE session_id = $1
       ORDER BY seq ASC
       LIMIT 1`,
      [sessionId],
    );
    return rows[0] ? rowToEvent(rows[0]) : null;
  }

  async claim(sessionId: string, ownerId: string, leaseMs: number): Promise<PendingEventClaim | null> {
    if (ownerId.length === 0) throw new RangeError("pending event ownerId must not be empty");
    this.validateLeaseMs(leaseMs);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Acquire the row lock without any time predicate. PostgreSQL may evaluate
      // WHERE/SET expressions before a lock wait, so all lease-clock checks must
      // happen in the following statement, after this SELECT has returned.
      const head = await client.query<{ id: string }>(
        `SELECT id FROM pending_events
         WHERE session_id = $1
         ORDER BY seq ASC
         LIMIT 1
         FOR UPDATE`,
        [sessionId],
      );
      if (!head.rows[0]) {
        await client.query("COMMIT");
        return null;
      }
      const { rows } = await client.query<PendingRow>(
        `UPDATE pending_events
         SET claim_generation = claim_generation + 1,
             claim_owner = $2,
             claim_expires_at = clock_timestamp() + CAST($3 || ' milliseconds' AS interval)
         WHERE id = $1
           AND (claim_owner IS NULL OR claim_expires_at <= clock_timestamp())
         RETURNING id, session_id, type, data, session_thread_id, api_key_id, arrived_at,
                   claim_owner, claim_expires_at, claim_generation`,
        [head.rows[0].id, ownerId, leaseMs],
      );
      await client.query("COMMIT");
      const row = rows[0];
      return row ? {
        event: rowToEvent(row),
        ownerId: row.claim_owner!,
        generation: Number(row.claim_generation),
        expiresAt: new Date(row.claim_expires_at!),
      } : null;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async renewClaim(
    sessionId: string,
    eventId: string,
    claim: PendingEventClaimRef,
    leaseMs: number,
  ): Promise<boolean> {
    this.validateLeaseMs(leaseMs);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<{ id: string }>(
        `SELECT id FROM pending_events
         WHERE session_id = $1 AND id = $2
         FOR UPDATE`,
        [sessionId, eventId],
      );
      if (!locked.rows[0]) {
        await client.query("COMMIT");
        return false;
      }
      const { rows } = await client.query<{ id: string }>(
        `UPDATE pending_events
         SET claim_expires_at = clock_timestamp() + CAST($5 || ' milliseconds' AS interval)
         WHERE session_id = $1
           AND id = $2
           AND claim_owner = $3
           AND claim_generation = $4
           AND claim_expires_at > clock_timestamp()
         RETURNING id`,
        [sessionId, eventId, claim.ownerId, claim.generation, leaseMs],
      );
      await client.query("COMMIT");
      return rows.length > 0;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseClaim(
    sessionId: string,
    eventId: string,
    claim: PendingEventClaimRef,
  ): Promise<boolean> {
    const { rows } = await this.pool.query<{ id: string }>(
      `UPDATE pending_events
       SET claim_owner = NULL, claim_expires_at = NULL
       WHERE session_id = $1
         AND id = $2
         AND claim_owner = $3
         AND claim_generation = $4
       RETURNING id`,
      [sessionId, eventId, claim.ownerId, claim.generation],
    );
    return rows.length > 0;
  }

  async ownsClaim(
    sessionId: string,
    eventId: string,
    claim: PendingEventClaimRef,
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<{ id: string }>(
        `SELECT id FROM pending_events
         WHERE session_id = $1 AND id = $2
         FOR UPDATE`,
        [sessionId, eventId],
      );
      if (!locked.rows[0]) {
        await client.query("COMMIT");
        return false;
      }
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM pending_events
         WHERE session_id = $1
           AND id = $2
           AND claim_owner = $3
           AND claim_generation = $4
           AND claim_expires_at > clock_timestamp()`,
        [sessionId, eventId, claim.ownerId, claim.generation],
      );
      await client.query("COMMIT");
      return rows.length > 0;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async ack(
    sessionId: string,
    eventId: string,
    claim?: PendingEventClaimRef,
  ): Promise<boolean> {
    return (await this.acknowledge(sessionId, eventId, claim, false)).acknowledged;
  }

  async ackCompletedTurn(sessionId: string, eventId: string, claim: PendingEventClaimRef) {
    return this.acknowledge(sessionId, eventId, claim, true);
  }

  private async acknowledge(
    sessionId: string,
    eventId: string,
    claim: PendingEventClaimRef | undefined,
    completed: boolean,
  ): Promise<{ acknowledged: boolean; idleEvent?: StoredEvent }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (completed) {
        // Session-first matches ingress, termination and fenced event writes.
        // Ingress cannot slip between the empty check and committing idle.
        const session = await client.query<{ status: string }>(
          `SELECT status FROM sessions WHERE id = $1 FOR UPDATE`, [sessionId],
        );
        if (!session.rows[0] || session.rows[0].status === "terminated") {
          await client.query("COMMIT");
          return { acknowledged: false };
        }
        const marker = await client.query(
          `SELECT seq FROM events WHERE session_id = $1 AND idempotency_key = $2
           AND type = 'session.turn_completed'`, [sessionId, `pending:${eventId}:completed`],
        );
        if (!marker.rows.length) throw new Error("Cannot acknowledge a Turn without its completion marker");
      }
      const head = await client.query<{ id: string }>(
        `SELECT id FROM pending_events
         WHERE session_id = $1
         ORDER BY seq ASC
         LIMIT 1
         FOR UPDATE`,
        [sessionId],
      );
      if (head.rows[0]?.id !== eventId) {
        await client.query("COMMIT");
        return { acknowledged: false };
      }
      const params: unknown[] = [sessionId, eventId];
      let fence = "AND claim_owner IS NULL";
      if (claim) {
        params.push(claim.ownerId, claim.generation);
        fence = `AND claim_owner = $3
                 AND claim_generation = $4
                 AND claim_expires_at > clock_timestamp()`;
      }
      const { rows } = await client.query<{ id: string }>(
        `DELETE FROM pending_events
         WHERE session_id = $1 AND id = $2 ${fence}
         RETURNING id`,
        params,
      );
      let idleEvent: StoredEvent | undefined;
      if (completed && rows.length > 0) {
        const remaining = await client.query(`SELECT id FROM pending_events WHERE session_id = $1 LIMIT 1`, [sessionId]);
        if (!remaining.rows.length) {
          await client.query(`UPDATE sessions SET status = 'idle', updated_at = $2 WHERE id = $1`, [sessionId, new Date()]);
          await client.query(`INSERT INTO event_counters (session_id, seq) VALUES ($1, 0) ON CONFLICT (session_id) DO NOTHING`, [sessionId]);
          await client.query(`SELECT seq FROM event_counters WHERE session_id = $1 FOR UPDATE`, [sessionId]);
          const key = `pending:${eventId}:status_idle`;
          // Old Hosts wrote idle before completion; preserve that event on recovery.
          const existing = await client.query(`SELECT * FROM events WHERE session_id = $1 AND idempotency_key = $2`, [sessionId, key]);
          let row = existing.rows[0];
          if (!row) {
            const counter = await client.query(`UPDATE event_counters SET seq = seq + 1 WHERE session_id = $1 RETURNING seq`, [sessionId]);
            const inserted = await client.query(
              `INSERT INTO events (session_id, seq, type, data, ts, session_thread_id, idempotency_key)
               VALUES ($1, $2, 'session.status_idle', '{}', $3, 'sthr_primary', $4) RETURNING *`,
              [sessionId, counter.rows[0].seq, new Date(), key],
            );
            row = inserted.rows[0];
          }
          idleEvent = { sessionId, seq: Number(row.seq), type: row.type, data: row.data,
            ts: new Date(row.ts), sessionThreadId: row.session_thread_id };
        }
      }
      await client.query("COMMIT");
      return { acknowledged: rows.length > 0, ...(idleEvent ? { idleEvent } : {}) };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async listPendingSessionIds(): Promise<string[]> {
    const { rows } = await this.pool.query<{ session_id: string }>(
      `SELECT DISTINCT session_id FROM pending_events ORDER BY session_id ASC`,
    );
    return rows.map((row) => row.session_id);
  }

  async clear(sessionId: string): Promise<void> {
    await this.pool.query(`DELETE FROM pending_events WHERE session_id = $1`, [sessionId]);
  }

  async count(sessionId: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM pending_events WHERE session_id = $1`,
      [sessionId],
    );
    return Number(rows[0].count);
  }

  async listUnclaimed(sessionId: string, limit: number): Promise<PendingEvent[]> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError("pending event listUnclaimed limit must be a positive integer");
    }
    // The claim predicate mirrors `claim`: an unowned row, or one whose lease has
    // lapsed, is input still waiting to run. A live claim is excluded because the
    // drainer already promoted it into the event log.
    const { rows } = await this.pool.query<PendingRow>(
      `SELECT id, session_id, type, data, session_thread_id, arrived_at
       FROM pending_events
       WHERE session_id = $1
         AND (claim_owner IS NULL OR claim_expires_at <= clock_timestamp())
       ORDER BY seq ASC
       LIMIT $2`,
      [sessionId, limit],
    );
    return rows.map(rowToEvent);
  }
}
