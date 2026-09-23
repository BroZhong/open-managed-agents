import type { ActiveTurn, TurnDelta, TurnStreamStore } from "./turn-stream-store.js";

/** Redis is an optional live projection; failures must never fail a Turn. */
export class BestEffortTurnStreamStore implements TurnStreamStore {
  constructor(private readonly inner: TurnStreamStore, private readonly ready: () => boolean) {}
  private async attempt<T>(fallback: T, work: () => Promise<T>): Promise<T> {
    if (!this.ready()) return fallback;
    try { return await work(); } catch { return fallback; }
  }
  appendDelta(sessionId: string, delta: TurnDelta) { return this.attempt("", () => this.inner.appendDelta(sessionId, delta)); }
  readDeltas(sessionId: string, turnId: string, afterId?: string) { return this.attempt([], () => this.inner.readDeltas(sessionId, turnId, afterId)); }
  deltaCount(sessionId: string, turnId: string) { return this.attempt(0, () => this.inner.deltaCount(sessionId, turnId)); }
  reclaim(sessionId: string, turnId: string) { return this.attempt(undefined, () => this.inner.reclaim(sessionId, turnId)); }
  setActiveTurn(sessionId: string, turn: ActiveTurn) { return this.attempt(undefined, () => this.inner.setActiveTurn(sessionId, turn)); }
  getActiveTurn(sessionId: string) { return this.attempt(null, () => this.inner.getActiveTurn(sessionId)); }
  clearActiveTurn(sessionId: string) { return this.attempt(undefined, () => this.inner.clearActiveTurn(sessionId)); }
  compareAndSetActiveTurn(sessionId: string, expected: string | null, next: ActiveTurn | null) {
    // Failure is not a lost execution lease. Only PG fences execution authority.
    return this.attempt(true, () => this.inner.compareAndSetActiveTurn!(sessionId, expected, next));
  }
}
