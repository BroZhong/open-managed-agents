import type { RedisClient } from "./index.js";

/** Ephemeral hints only. No pending payloads, claims or durable history here. */
export interface SessionSignal {
  sessionId: string;
  kind: "wake" | "durable" | "chunk";
  chunk?: { type: string; data: unknown; turnId?: string; blockIndex?: number; deltaId?: string };
}
export interface SessionSignals {
  publish(signal: SessionSignal): void;
  subscribe(listener: (signal: SessionSignal) => void): () => void;
}

export class RedisSessionSignals implements SessionSignals {
  private readonly subscriber: RedisClient;
  private readonly listeners = new Set<(signal: SessionSignal) => void>();
  private readonly channel: string;
  constructor(private readonly publisher: RedisClient, namespace = "oma") {
    this.channel = `${namespace}:session-signals`;
    this.subscriber = publisher.duplicate({ lazyConnect: true });
    this.subscriber.on("error", () => {});
    // Retry subscription on every reconnect, including an unavailable first boot.
    this.subscriber.on("ready", () => {
      void this.subscriber.subscribe(this.channel).catch(() => {});
    });
    this.subscriber.on("message", (channel, raw) => {
      if (channel !== this.channel) return;
      try {
        const signal = JSON.parse(raw) as SessionSignal;
        if (typeof signal.sessionId !== "string") return;
        for (const listener of this.listeners) listener(signal);
      } catch { /* Invalid transient messages cannot take down execution. */ }
    });
    void this.subscriber.connect().catch(() => {});
  }
  publish(signal: SessionSignal): void {
    // Never queue unbounded notifications during outages or wait for Redis on
    // the durable acceptance / execution path. PG scanning closes this window.
    if (this.publisher.status !== "ready") return;
    void this.publisher.publish(this.channel, JSON.stringify(signal)).catch(() => {});
  }
  subscribe(listener: (signal: SessionSignal) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  close(): void { this.listeners.clear(); this.subscriber.disconnect(); }
}
