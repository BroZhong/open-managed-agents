import type { SessionRouter } from "@oma-server/session-router";
import type { SessionStore } from "@oma-server/store";
import type { SessionSignals } from "@oma-server/redis";

/** Notifications accelerate work; the independent PG scan guarantees discovery. */
export class RunnerDispatch {
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private scanning?: Promise<void>;
  private cleaning?: Promise<void>;
  private lastScan = 0;
  private readonly waking = new Set<string>();
  constructor(private readonly deps: {
    router: SessionRouter; sessions: SessionStore; signals: SessionSignals;
    scanIntervalMs?: number; cleanup?: () => Promise<void>;
  }) {
    const ms = this.interval;
    if (!Number.isFinite(ms) || ms < 1) throw new RangeError("Pending scan interval must be positive");
  }
  private get interval() { return this.deps.scanIntervalMs ?? 5000; }
  get ready(): boolean { return Date.now() - this.lastScan < Math.max(30_000, this.interval * 3); }
  async start(): Promise<void> {
    // Subscribed until the signals close: a Runner shutting down still runs
    // its Turns until the handoff deadline, and acts on their check hints.
    this.deps.signals.subscribe(signal => {
      if (signal.kind === "wake" && !this.stopped) this.wake(signal.sessionId);
      // Not deduplicated like wakes: a drain started from a wake holds its
      // Session in `waking` for the whole Turn, and the owner must still check.
      if (signal.kind === "check") this.deps.router.checkNow(signal.sessionId);
    });
    await this.scan();
    this.timer = setInterval(() => { void this.scan(); }, this.interval);
    this.timer.unref?.();
  }
  private wake(sessionId: string): void {
    if (this.waking.has(sessionId)) return;
    this.waking.add(sessionId);
    void this.deps.sessions.getById(sessionId).then(async session => {
      if (session && session.status !== "terminated") await this.deps.router.handleNewEvent(sessionId, session.agent);
      // Termination is discovered by durable cleanup scanning, while PG fences
      // the active owner's heartbeat independently of Redis availability.
    }).catch(error => console.error("Runner wake failed:", error))
      .finally(() => this.waking.delete(sessionId));
  }
  private scan(): Promise<void> {
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      const result = await this.deps.router.recoverPendingEvents(failure => console.error("Runner execution failed:", failure));
      for (const failure of result.failed) console.error("Runner recovery failed:", failure);
      // Slow gateway cleanup must not delay the independent five-second scan.
      if (!this.cleaning && this.deps.cleanup) {
        this.cleaning = this.deps.cleanup().catch(error => console.error("Runner cleanup failed:", error))
          .finally(() => { this.cleaning = undefined; });
      }
      this.lastScan = Date.now();
    })().catch(error => console.error("Runner scan failed:", error))
      .finally(() => { this.scanning = undefined; });
    return this.scanning;
  }
  /** Stop claiming input: no more pending scans, and wakes are ignored (#254). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.scanning;
    await this.cleaning;
  }
}
