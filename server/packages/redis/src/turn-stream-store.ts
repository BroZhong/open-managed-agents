import type { RedisLike } from "./redis-like.js";

/**
 * A token-level delta emitted during a turn. Deltas live only in the per-turn
 * Redis stream `stream:session:{sessionId}:turn:{turnId}`; they are NEVER persisted to PostgreSQL.
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
  /**
   * The claim generation of the attempt that streamed this delta. Every attempt
   * of one input appends to the same Turn stream and numbers its blocks after
   * the committed ones, so a lost attempt's partial block and its successor's
   * can share `(turnId, blockIndex)`; readers keep only the highest attempt.
   */
  attempt: number;
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
  /**
   * The seq the Turn's input was promoted to. A Session runs its inputs one
   * after another, so a later input's Turn has a higher one.
   */
  inputSeq: number;
  /**
   * The claim generation of the attempt that recorded it. Every attempt of one
   * input executes the same Turn, so this, not the Turn, tells a later attempt
   * from the one it took the Turn over from.
   */
  generation: number;
}

/**
 * The attempt that writes a projection: its input and its claim generation.
 * Attempts are ordered by input, then by generation.
 */
export type ActiveTurnWriter = Pick<ActiveTurn, "inputSeq" | "generation">;

/**
 * Transient per-turn delta streams + the active-turn map, backed by Redis so
 * reconnect stays correct across multiple Host instances (nothing lives in
 * process memory).
 *
 * - Deltas: `stream:session:{sessionId}:turn:{turnId}` (XADD append, XRANGE replay, DEL reclaim);
 *   each append slides a 30-minute expiry, so streams nobody reclaims still disappear.
 * - Active turn: hash `session:active-turn:{sessionId}` → { turnId, status, inputSeq, generation }.
 *   An attempt writes it only while no later attempt has: a Runner that stalls
 *   past its lease must not hide the Turn that replaced its own.
 */
export interface TurnStreamStore {
  /** Session ownership is mandatory: Turn IDs are only unique within a Session.
   * Append a delta to its turn's stream. Returns the stream entry id. */
  appendDelta(sessionId: string, delta: TurnDelta): Promise<string>;
  /** Read all deltas for a turn (optionally only those after a stream id). */
  readDeltas(sessionId: string, turnId: string, afterId?: string): Promise<StoredTurnDelta[]>;
  /** Number of deltas currently buffered for a turn. */
  deltaCount(sessionId: string, turnId: string): Promise<number>;
  /** Reclaim (DEL) a turn's delta stream — called when the turn ends. */
  reclaim(sessionId: string, turnId: string): Promise<void>;

  /** Set the active turn for a session unconditionally (seeding, tests). */
  setActiveTurn(sessionId: string, turn: ActiveTurn): Promise<void>;
  /** Read the active turn for a session, or null if none. */
  getActiveTurn(sessionId: string): Promise<ActiveTurn | null>;
  /**
   * Atomically record the Turn its attempt runs, unless a later attempt has
   * recorded the active turn: one of a later input, or a later generation of
   * the same input. Returns whether it was recorded.
   */
  recordActiveTurn(sessionId: string, turn: ActiveTurn): Promise<boolean>;
  /**
   * Atomically delete the active turn for `writer`'s attempt, under the same
   * rule: one a later attempt recorded stays. Returns whether it was deleted.
   */
  clearActiveTurn(sessionId: string, writer: ActiveTurnWriter): Promise<boolean>;
}

function turnStreamKey(sessionId: string, turnId: string): string {
  return `stream:session:${encodeURIComponent(sessionId)}:turn:${encodeURIComponent(turnId)}`;
}

function activeTurnKey(sessionId: string): string {
  return `session:active-turn:${sessionId}`;
}

// Refuses the write when the recorded attempt is later than the writer;
// otherwise replaces the hash whole (no field of an older writer survives),
// or deletes it when no Turn is given. A projection recorded before
// projections carried an input seq or a generation counts as input 0 and
// generation 0, the ones before the first input and the first claim, so any
// attempt replaces it.
const ACTIVE_TURN_WRITE_SCRIPT = `-- oma:active-turn-write
local inputSeq = tonumber(redis.call('HGET', KEYS[1], 'inputSeq') or '0')
local generation = tonumber(redis.call('HGET', KEYS[1], 'generation') or '0')
local writerInputSeq = tonumber(ARGV[1])
local writerGeneration = tonumber(ARGV[2])
if inputSeq > writerInputSeq or (inputSeq == writerInputSeq and generation > writerGeneration) then return 0 end
redis.call('DEL', KEYS[1])
if ARGV[3] ~= '' then
  redis.call('HSET', KEYS[1], 'turnId', ARGV[3], 'status', ARGV[4], 'inputSeq', ARGV[1], 'generation', ARGV[2])
end
return 1`;

/**
 * Sliding expiry of a Turn's delta stream, pushed out again by every append.
 * A streaming Turn never loses its backfill mid-way, while a stream orphaned by
 * a lost Runner (the Turn never ends normally, so nothing reclaims it) frees
 * its memory on its own.
 */
const TURN_DELTA_STREAM_TTL_MS = 30 * 60 * 1000;

// One script, so no client crash, command timeout or dropped connection can
// land the XADD without the PEXPIRE and leave a stream that never expires.
const APPEND_DELTA_SCRIPT = `-- oma:turn-delta-append
local id = redis.call('XADD', KEYS[1], '*', unpack(ARGV, 2))
redis.call('PEXPIRE', KEYS[1], ARGV[1])
return id`;

export class RedisTurnStreamStore implements TurnStreamStore {
  constructor(private readonly redis: RedisLike) {}

  async appendDelta(sessionId: string, delta: TurnDelta): Promise<string> {
    const id = await this.redis.eval(
      APPEND_DELTA_SCRIPT,
      1,
      turnStreamKey(sessionId, delta.turnId),
      String(TURN_DELTA_STREAM_TTL_MS),
      "turnId",
      delta.turnId,
      "blockIndex",
      String(delta.blockIndex),
      "attempt",
      String(delta.attempt),
      "type",
      delta.type,
      "data",
      JSON.stringify(delta.data ?? null),
    );
    // The script returns XADD's reply; with an explicit "*" id that is always
    // the generated id.
    return String(id);
  }

  async readDeltas(sessionId: string, turnId: string, afterId?: string): Promise<StoredTurnDelta[]> {
    // XRANGE is inclusive; use the exclusive "(id" form to skip already-seen
    // entries when resuming after a stream id.
    const start = afterId ? `(${afterId}` : "-";
    const entries = await this.redis.xrange(turnStreamKey(sessionId, turnId), start, "+");
    return entries.map(([id, fields]) => {
      const map = fieldsToRecord(fields);
      return {
        id,
        turnId: map.turnId ?? turnId,
        blockIndex: Number(map.blockIndex ?? "0"),
        // Claim generations start at 1, so an entry without one is the earliest.
        attempt: Number(map.attempt ?? "0"),
        type: map.type ?? "",
        data: map.data !== undefined ? safeParse(map.data) : null,
      };
    });
  }

  async deltaCount(sessionId: string, turnId: string): Promise<number> {
    return this.redis.xlen(turnStreamKey(sessionId, turnId));
  }

  async reclaim(sessionId: string, turnId: string): Promise<void> {
    await this.redis.del(turnStreamKey(sessionId, turnId));
  }

  async setActiveTurn(sessionId: string, turn: ActiveTurn): Promise<void> {
    await this.redis.hset(
      activeTurnKey(sessionId),
      "turnId",
      turn.turnId,
      "status",
      turn.status,
      "inputSeq",
      String(turn.inputSeq),
      "generation",
      String(turn.generation),
    );
  }

  async getActiveTurn(sessionId: string): Promise<ActiveTurn | null> {
    const map = await this.redis.hgetall(activeTurnKey(sessionId));
    if (!map || !map.turnId) return null;
    return {
      turnId: map.turnId,
      status: (map.status as ActiveTurnStatus) ?? "idle",
      // Event seqs and claim generations start at 1, so a projection without
      // them is the earliest.
      inputSeq: Number(map.inputSeq ?? "0"),
      generation: Number(map.generation ?? "0"),
    };
  }

  async recordActiveTurn(sessionId: string, turn: ActiveTurn): Promise<boolean> {
    return this.writeActiveTurn(sessionId, turn, turn);
  }

  async clearActiveTurn(sessionId: string, writer: ActiveTurnWriter): Promise<boolean> {
    return this.writeActiveTurn(sessionId, writer, null);
  }

  private async writeActiveTurn(sessionId: string, writer: ActiveTurnWriter, turn: ActiveTurn | null): Promise<boolean> {
    const result = await this.redis.eval(
      ACTIVE_TURN_WRITE_SCRIPT,
      1,
      activeTurnKey(sessionId),
      String(writer.inputSeq),
      String(writer.generation),
      turn?.turnId ?? "",
      turn?.status ?? "",
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
