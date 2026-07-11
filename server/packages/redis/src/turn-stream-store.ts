import type { RedisLike } from "./redis-like.js";

/**
 * A token-level delta emitted during a turn. Deltas live only in the per-turn
 * Redis stream `stream:turn:{turnId}`; they are NEVER persisted to PostgreSQL.
 *
 * `turnId` + `blockIndex` align a delta to the full Event it will eventually
 * roll up into: all deltas for one content block of one turn share the same
 * `(turnId, blockIndex)`, and the authoritative full Event carries the same
 * pair, so a reconnecting client can stitch half-emitted content to its final
 * form without ambiguity.
 */
export interface TurnDelta {
  /** The turn this delta belongs to. */
  turnId: string;
  /** Which content block within the turn (increments on each stream_start). */
  blockIndex: number;
  /** Stream event type (e.g. "agent.message_chunk"). */
  type: string;
  /** The raw stream event payload. */
  data: unknown;
}

/** A delta read back from the stream, tagged with its Redis stream entry id. */
export interface StoredTurnDelta extends TurnDelta {
  /** The Redis stream entry id (millis-seq), monotonic within the stream. */
  id: string;
}

export type ActiveTurnStatus = "running" | "idle";

export interface ActiveTurn {
  turnId: string;
  status: ActiveTurnStatus;
}

/**
 * Transient per-turn delta streams + the active-turn map, backed by Redis so
 * reconnect stays correct across multiple Host instances (nothing lives in
 * process memory).
 *
 * - Deltas: `stream:turn:{turnId}` (XADD append, XRANGE replay, DEL reclaim).
 * - Active turn: hash `session:active-turn:{sessionId}` → { turnId, status }.
 */
export interface TurnStreamStore {
  /** Append a delta to its turn's stream. Returns the stream entry id. */
  appendDelta(delta: TurnDelta): Promise<string>;
  /** Read all deltas for a turn (optionally only those after a stream id). */
  readDeltas(turnId: string, afterId?: string): Promise<StoredTurnDelta[]>;
  /** Number of deltas currently buffered for a turn. */
  deltaCount(turnId: string): Promise<number>;
  /** Reclaim (DEL) a turn's delta stream — called when the turn ends. */
  reclaim(turnId: string): Promise<void>;

  /** Record the active turn for a session and its status. */
  setActiveTurn(sessionId: string, turn: ActiveTurn): Promise<void>;
  /** Read the active turn for a session, or null if none. */
  getActiveTurn(sessionId: string): Promise<ActiveTurn | null>;
  /** Clear the active-turn record for a session. */
  clearActiveTurn(sessionId: string): Promise<void>;
  /** Atomically replace/delete only the exact active turn observed by caller. */
  compareAndSetActiveTurn?(
    sessionId: string,
    expectedTurnId: string | null,
    next: ActiveTurn | null,
  ): Promise<boolean>;
}

function turnStreamKey(turnId: string): string {
  return `stream:turn:${turnId}`;
}

function activeTurnKey(sessionId: string): string {
  return `session:active-turn:${sessionId}`;
}

const ACTIVE_TURN_CAS_SCRIPT = `-- oma:active-turn-cas
local current = redis.call('HGET', KEYS[1], 'turnId') or ''
if current ~= ARGV[1] then return 0 end
if ARGV[2] == '' then
  redis.call('DEL', KEYS[1])
else
  redis.call('HSET', KEYS[1], 'turnId', ARGV[2], 'status', ARGV[3])
end
return 1`;

export class RedisTurnStreamStore implements TurnStreamStore {
  constructor(private readonly redis: RedisLike) {}

  async appendDelta(delta: TurnDelta): Promise<string> {
    const id = await this.redis.xadd(
      turnStreamKey(delta.turnId),
      "*",
      "turnId",
      delta.turnId,
      "blockIndex",
      String(delta.blockIndex),
      "type",
      delta.type,
      "data",
      JSON.stringify(delta.data ?? null),
    );
    // XADD with an explicit "*" id always returns the generated id.
    return id ?? "";
  }

  async readDeltas(turnId: string, afterId?: string): Promise<StoredTurnDelta[]> {
    // XRANGE is inclusive; use the exclusive "(id" form to skip already-seen
    // entries when resuming after a stream id.
    const start = afterId ? `(${afterId}` : "-";
    const entries = await this.redis.xrange(turnStreamKey(turnId), start, "+");
    return entries.map(([id, fields]) => {
      const map = fieldsToRecord(fields);
      return {
        id,
        turnId: map.turnId ?? turnId,
        blockIndex: Number(map.blockIndex ?? "0"),
        type: map.type ?? "",
        data: map.data !== undefined ? safeParse(map.data) : null,
      };
    });
  }

  async deltaCount(turnId: string): Promise<number> {
    return this.redis.xlen(turnStreamKey(turnId));
  }

  async reclaim(turnId: string): Promise<void> {
    await this.redis.del(turnStreamKey(turnId));
  }

  async setActiveTurn(sessionId: string, turn: ActiveTurn): Promise<void> {
    await this.redis.hset(
      activeTurnKey(sessionId),
      "turnId",
      turn.turnId,
      "status",
      turn.status,
    );
  }

  async getActiveTurn(sessionId: string): Promise<ActiveTurn | null> {
    const map = await this.redis.hgetall(activeTurnKey(sessionId));
    if (!map || !map.turnId) return null;
    return {
      turnId: map.turnId,
      status: (map.status as ActiveTurnStatus) ?? "idle",
    };
  }

  async clearActiveTurn(sessionId: string): Promise<void> {
    await this.redis.del(activeTurnKey(sessionId));
  }

  async compareAndSetActiveTurn(
    sessionId: string,
    expectedTurnId: string | null,
    next: ActiveTurn | null,
  ): Promise<boolean> {
    const result = await this.redis.eval(
      ACTIVE_TURN_CAS_SCRIPT,
      1,
      activeTurnKey(sessionId),
      expectedTurnId ?? "",
      next?.turnId ?? "",
      next?.status ?? "",
    );
    return Number(result) === 1;
  }
}

function fieldsToRecord(fields: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) {
    out[fields[i]] = fields[i + 1];
  }
  return out;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
