import type {
  ActiveTurn,
  ActiveTurnWriter,
  StoredTurnDelta,
  TurnDelta,
  TurnStreamStore,
} from "./turn-stream-store.js";

/**
 * In-memory {@link TurnStreamStore} for dev + tests. Holds per-turn delta
 * streams and the active-turn map in process memory instead of Redis, so route
 * tests can drive turn status (`running` / `idle` / no record) without a live
 * Redis. Behaviour mirrors {@link RedisTurnStreamStore}: append/read deltas,
 * reclaim, and read/write the active-turn record, which no attempt earlier
 * than the one that recorded it can replace.
 */
export class InMemoryTurnStreamStore implements TurnStreamStore {
  streams = new Map<string, StoredTurnDelta[]>();
  activeTurns = new Map<string, ActiveTurn>();
  private seq = 0;

  async appendDelta(sessionId: string, delta: TurnDelta): Promise<string> {
    const id = `0-${this.seq++}`;
    const list = this.streams.get(JSON.stringify([sessionId, delta.turnId])) ?? [];
    list.push({ ...delta, id });
    this.streams.set(JSON.stringify([sessionId, delta.turnId]), list);
    return id;
  }

  async readDeltas(sessionId: string, turnId: string, afterId?: string): Promise<StoredTurnDelta[]> {
    const list = this.streams.get(JSON.stringify([sessionId, turnId])) ?? [];
    if (!afterId) return [...list];
    const idx = list.findIndex((d) => d.id === afterId);
    return list.slice(idx + 1);
  }

  async deltaCount(sessionId: string, turnId: string): Promise<number> {
    return this.streams.get(JSON.stringify([sessionId, turnId]))?.length ?? 0;
  }

  async reclaim(sessionId: string, turnId: string): Promise<void> {
    this.streams.delete(JSON.stringify([sessionId, turnId]));
  }

  async setActiveTurn(sessionId: string, turn: ActiveTurn): Promise<void> {
    this.activeTurns.set(sessionId, { ...turn });
  }

  async getActiveTurn(sessionId: string): Promise<ActiveTurn | null> {
    return this.activeTurns.get(sessionId) ?? null;
  }

  async recordActiveTurn(sessionId: string, turn: ActiveTurn): Promise<boolean> {
    if (this.recordedLater(sessionId, turn)) return false;
    this.activeTurns.set(sessionId, { ...turn });
    return true;
  }

  async clearActiveTurn(sessionId: string, writer: ActiveTurnWriter): Promise<boolean> {
    if (this.recordedLater(sessionId, writer)) return false;
    this.activeTurns.delete(sessionId);
    return true;
  }

  private recordedLater(sessionId: string, writer: ActiveTurnWriter): boolean {
    const current = this.activeTurns.get(sessionId);
    return current !== undefined && (current.inputSeq > writer.inputSeq ||
      (current.inputSeq === writer.inputSeq && current.generation > writer.generation));
  }
}
