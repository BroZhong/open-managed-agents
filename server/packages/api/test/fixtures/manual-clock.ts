import type { Clock } from "../../src/image-builder/ports.js";

/** Let pending promise callbacks run. */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A {@link Clock} that moves only when a test advances it. */
export class ManualClock implements Clock {
  private timers: Array<{ at: number; resolve: () => void }> = [];
  constructor(private time = Date.parse("2026-10-26T01:00:00Z")) {}

  now(): number {
    return this.time;
  }

  date = (): Date => new Date(this.time);

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const timer = { at: this.time + Math.max(0, ms), resolve: () => { signal?.removeEventListener("abort", abort); resolve(); } };
      const abort = () => {
        this.timers = this.timers.filter((candidate) => candidate !== timer);
        reject(signal!.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.timers.push(timer);
    });
  }

  /** Move time forward, firing due timers in order and letting their callbacks run. */
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    await settle();
    for (;;) {
      const next = Math.min(...this.timers.map((timer) => timer.at));
      if (!(next <= end)) break;
      // Every timer due at that instant fires before their callbacks run.
      const due = this.timers.filter((timer) => timer.at === next);
      this.timers = this.timers.filter((timer) => timer.at !== next);
      this.time = Math.max(this.time, next);
      for (const timer of due) timer.resolve();
      await settle(8);
    }
    this.time = end;
    await settle();
  }
}
