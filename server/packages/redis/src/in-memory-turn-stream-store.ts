import type {
  ActiveTurn,
  StoredTurnDelta,
  TurnDelta,
  TurnStreamStore,
} from "./turn-stream-store.js";

/**
 * In-memory {@link TurnStreamStore} for dev + tests. Holds per-turn delta
 * streams and the active-turn map in process memory instead of Redis, so route
 * tests can drive turn status (`running` / `idle` / no record) without a live
 * Redis. Behaviour mirrors {@link RedisTurnStreamStore}: append/read deltas,
 * reclaim, and read/write the active-turn record.
 */
export class InMemoryTurnStreamStore implements TurnStreamStore {
  streams = new Map<string, StoredTurnDelta[]>();
  activeTurns = new Map<string, ActiveTurn>();
  private seq = 0;

  async appendDelta(delta: TurnDelta): Promise<string> {
    const id = `0-${this.seq++}`;
    const list = this.streams.get(delta.turnId) ?? [];
    list.push({ ...delta, id });
    this.streams.set(delta.turnId, list);
    return id;
  }

  async readDeltas(turnId: string, afterId?: string): Promise<StoredTurnDelta[]> {
    const list = this.streams.get(turnId) ?? [];
    if (!afterId) return [...list];
    const idx = list.findIndex((d) => d.id === afterId);
    return list.slice(idx + 1);
  }

  async deltaCount(turnId: string): Promise<number> {
    return this.streams.get(turnId)?.length ?? 0;
  }

  async reclaim(turnId: string): Promise<void> {
    this.streams.delete(turnId);
  }

  async setActiveTurn(sessionId: string, turn: ActiveTurn): Promise<void> {
    this.activeTurns.set(sessionId, { ...turn });
  }

  async getActiveTurn(sessionId: string): Promise<ActiveTurn | null> {
    return this.activeTurns.get(sessionId) ?? null;
  }

  async clearActiveTurn(sessionId: string): Promise<void> {
    this.activeTurns.delete(sessionId);
  }

  async compareAndSetActiveTurn(
    sessionId: string,
    expectedTurnId: string | null,
    next: ActiveTurn | null,
  ): Promise<boolean> {
    const current = this.activeTurns.get(sessionId)?.turnId ?? null;
    if (current !== expectedTurnId) return false;
    if (next) this.activeTurns.set(sessionId, next);
    else this.activeTurns.delete(sessionId);
    return true;
  }
}
