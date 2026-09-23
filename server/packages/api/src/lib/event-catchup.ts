import { presentEvent, type EventLogStore, type StoredEvent } from "@oma-server/store";

interface Follower {
  cursor(): number;
  accept(event: StoredEvent): void;
}

/** One bounded incremental PG reader per watched Session, shared by its clients. */
export class EventCatchup {
  private readonly sessions = new Map<string, { followers: Set<Follower>; timer: ReturnType<typeof setInterval>; reading?: Promise<void> }>();
  constructor(private readonly store: EventLogStore, private readonly intervalMs = 2000) {
    if (!Number.isFinite(intervalMs) || intervalMs < 1) throw new RangeError("SSE catch-up interval must be positive");
  }

  follow(sessionId: string, follower: Follower): () => void {
    let state = this.sessions.get(sessionId);
    if (!state) {
      const timer = setInterval(() => this.refresh(sessionId), this.intervalMs);
      timer.unref?.();
      state = { followers: new Set(), timer };
      this.sessions.set(sessionId, state);
    }
    state.followers.add(follower);
    this.refresh(sessionId);
    return () => {
      state.followers.delete(follower);
      if (!state.followers.size) {
        clearInterval(state.timer);
        if (this.sessions.get(sessionId) === state) this.sessions.delete(sessionId);
      }
    };
  }

  refresh(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.reading) return;
    state.reading = (async () => {
      for (let page = 0; page < 10 && state.followers.size; page++) {
        const afterSeq = Math.min(...[...state.followers].map(f => f.cursor()));
        const result = await this.store.getEvents(sessionId, { afterSeq, limit: 1000, payload: "reference" });
        for (const event of result.data.flatMap(event => presentEvent(event))) {
          for (const follower of state.followers) {
            if (event.seq > follower.cursor()) follower.accept(event);
          }
        }
        if (!result.hasMore || !result.data.length) break;
      }
    })().catch(error => {
      // A PG outage is retried on the next tick without closing every SSE socket.
      console.error(`Session event catch-up failed for ${sessionId}:`, error);
    }).finally(() => { state.reading = undefined; });
  }
}
