import type { SessionRouter } from "@oma-server/session-router";
import type { SessionStore } from "@oma-server/store";
import type { SessionSignals } from "@oma-server/redis";

/** Notifications accelerate work; the independent PG scan guarantees discovery. */
export class RunnerDispatch {
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
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
    this.unsubscribe = this.deps.signals.subscribe(signal => {
      if (signal.kind === "wake") this.wake(signal.sessionId);
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
  async stop(): Promise<void> {
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
    await this.scanning;
    await this.cleaning;
  }
}
