import type { Pool } from "./connection.js";
import type { EventLogStore, EventLogStoreAppendInput, EventLogStoreGetEventsOpts } from "../interfaces/event-log-store.js";
import type { PaginatedResult, StoredEvent } from "../types.js";

interface EventRow {
  session_id: string;
  seq: string | number;
  type: string;
  data: unknown;
  ts: Date;
  session_thread_id: string;
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

export class PgEventLogStore implements EventLogStore {
  constructor(private readonly pool: Pool) {}

  async append(sessionId: string, event: EventLogStoreAppendInput): Promise<StoredEvent> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Atomically allocate the next per-session sequence number. The UPSERT
      // increments an existing counter or starts at 1; RETURNING gives us the
      // allocated value under the row lock held by this transaction.
      const counter = await client.query<{ seq: string | number }>(
        `INSERT INTO event_counters (session_id, seq) VALUES ($1, 1)
         ON CONFLICT (session_id) DO UPDATE SET seq = event_counters.seq + 1
         RETURNING seq`,
        [sessionId],
      );
      const seq = Number(counter.rows[0].seq);
      const ts = new Date();

      const { rows } = await client.query<EventRow>(
        `INSERT INTO events (session_id, seq, type, data, ts, session_thread_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [sessionId, seq, event.type, JSON.stringify(event.data ?? null), ts, event.sessionThreadId],
      );

      await client.query("COMMIT");
      return rowToEvent(rows[0]);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
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
