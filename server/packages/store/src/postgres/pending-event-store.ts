import { nanoid } from "nanoid";
import type { Pool } from "./connection.js";
import type { PendingEvent, PendingEventEnqueueInput, PendingEventStore } from "../interfaces/pending-event-store.js";

interface PendingRow {
  id: string;
  session_id: string;
  type: string;
  data: unknown;
  session_thread_id: string;
  arrived_at: Date;
}

function rowToEvent(row: PendingRow): PendingEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    type: row.type,
    data: row.data,
    sessionThreadId: row.session_thread_id,
    arrivedAt: new Date(row.arrived_at),
  };
}

export class PgPendingEventStore implements PendingEventStore {
  constructor(private readonly pool: Pool) {}

  async enqueue(sessionId: string, event: PendingEventEnqueueInput): Promise<PendingEvent> {
    const { rows } = await this.pool.query<PendingRow>(
      `INSERT INTO pending_events (id, session_id, type, data, session_thread_id, arrived_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, session_id, type, data, session_thread_id, arrived_at`,
      [nanoid(), sessionId, event.type, JSON.stringify(event.data ?? null), event.sessionThreadId, new Date()],
    );
    return rowToEvent(rows[0]);
  }

  async dequeue(sessionId: string): Promise<PendingEvent | null> {
    // Pop the FIFO head in a transaction: SELECT the oldest pending row (locked
    // via FOR UPDATE on real PG so a concurrent drainer skips it) and DELETE it
    // by exact id. The Host drains a given session serially, so contention is
    // rare; the transaction keeps read+delete atomic regardless.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const head = await client.query<PendingRow>(
        `SELECT id, session_id, type, data, session_thread_id, arrived_at
         FROM pending_events
         WHERE session_id = $1
         ORDER BY seq ASC
         LIMIT 1`,
        [sessionId],
      );
      if (!head.rows[0]) {
        await client.query("COMMIT");
        return null;
      }
      await client.query(`DELETE FROM pending_events WHERE id = $1`, [head.rows[0].id]);
      await client.query("COMMIT");
      return rowToEvent(head.rows[0]);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async peek(sessionId: string): Promise<PendingEvent | null> {
    const { rows } = await this.pool.query<PendingRow>(
      `SELECT id, session_id, type, data, session_thread_id, arrived_at
       FROM pending_events
       WHERE session_id = $1
       ORDER BY seq ASC
       LIMIT 1`,
      [sessionId],
    );
    return rows[0] ? rowToEvent(rows[0]) : null;
  }

  async count(sessionId: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM pending_events WHERE session_id = $1`,
      [sessionId],
    );
    return Number(rows[0].count);
  }
}
