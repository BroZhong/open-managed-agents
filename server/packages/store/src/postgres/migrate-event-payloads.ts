import type { Pool } from "./connection.js";
import { EventPayloadCodec, eventPayloadRef, lazyEventData } from "../event-payload.js";

/** Bounded, resumable migration. Upload + read-back precede each conditional PG update. */
export async function migrateEventPayloads(pool: Pool, codec: EventPayloadCodec, options: { apply?: boolean; sessionId?: string } = {}) {
  const stats = { events: 0, checkpoints: 0, updated: 0, conflicts: 0, bytes: 0 };
  let session = "", seq = 0;
  for (;;) {
    const page = await pool.query<{ session_id: string; seq: string; type: string; data: unknown }>(
      `SELECT session_id, seq, type, data FROM events
       WHERE type IN ('agent.tool_result', 'agent.mcp_tool_result', 'agent.context_entry')
         AND (session_id > $1 OR (session_id = $1 AND seq > $2))
         ${options.sessionId ? "AND session_id = $3" : ""}
       ORDER BY session_id, seq LIMIT 50`, [session, seq, ...(options.sessionId ? [options.sessionId] : [])]);
    if (!page.rows.length) break;
    for (const row of page.rows) {
      session = row.session_id; seq = Number(row.seq);
      if (eventPayloadRef(row.data)) continue;
      const projected = lazyEventData(row.type, row.data);
      const ref = eventPayloadRef(projected);
      if (!ref) continue;
      stats.events++; stats.bytes += ref.bytes;
      if (!options.apply) continue;
      const encoded = await codec.encode(session, row.type, row.data);
      await codec.decode(session, encoded); // Hash/size verification, not merely PUT success.
      const changed = await pool.query("UPDATE events SET data=$1 WHERE session_id=$2 AND seq=$3 AND data=$4::jsonb",
        [JSON.stringify(encoded), session, seq, JSON.stringify(row.data)]);
      if (changed.rowCount) stats.updated++; else stats.conflicts++;
    }
  }
  let id = "";
  for (;;) {
    const page = await pool.query<{ id: string; record: { callerSessionId: string; checkpoint?: Record<string, unknown> } }>(
      `SELECT id, record FROM delegation_waits WHERE id > $1 ${options.sessionId ? "AND record->>'callerSessionId'=$2" : ""} ORDER BY id LIMIT 25`,
      [id, ...(options.sessionId ? [options.sessionId] : [])]);
    if (!page.rows.length) break;
    for (const row of page.rows) {
      id = row.id;
      const checkpoint = row.record.checkpoint;
      if (!Array.isArray(checkpoint?.events)) continue;
      const big = checkpoint.events.some(e => !eventPayloadRef(e) && eventPayloadRef(lazyEventData(e.type, e)));
      if (!big) continue;
      stats.checkpoints++;
      if (!options.apply) continue;
      const encoded = await codec.checkpoint(row.record.callerSessionId, checkpoint);
      await codec.checkpoint(row.record.callerSessionId, encoded, true);
      const changed = await pool.query("UPDATE delegation_waits SET record=$1 WHERE id=$2 AND record=$3::jsonb",
        [JSON.stringify({ ...row.record, checkpoint: encoded }), id, JSON.stringify(row.record)]);
      if (changed.rowCount) stats.updated++; else stats.conflicts++;
    }
  }
  return stats;
}
