import type { RedisClient } from "./index.js";

/**
 * Ephemeral hints only. No pending payloads, claims or durable history here.
 *  - wake: input may be claimable; any Runner may claim it.
 *  - check: the owner of the Session's running Turn re-reads its durable state
 *    now (an accepted Interrupt, a delegation command, a child result); other
 *    Runners ignore it.
 *  - sandbox: the binding whose id `sessionId` carries left Creating or
 *    finished its reclamation; Turns waiting for it read the row again
 *    (ADR-0023). Any Runner may hold such a Turn.
 *  - durable / chunk: an API's live stream catches up / receives a Delta.
 */
export interface SessionSignal {
  sessionId: string;
  kind: "wake" | "check" | "sandbox" | "durable" | "chunk";
  chunk?: { type: string; data: unknown; turnId?: string; blockIndex?: number; attempt?: number; deltaId?: string };
}

/**
 * Runners act on control signals (wake, check, sandbox); APIs relay
 * output signals (durable, chunk) to their live streams. Each scope has its
 * own channel, so a Runner never receives the fleet's output.
 */
export type SessionSignalScope = "control" | "output";

export function sessionSignalScope(kind: SessionSignal["kind"]): SessionSignalScope {
  return kind === "wake" || kind === "check" || kind === "sandbox" ? "control" : "output";
}

export interface SessionSignals {
  publish(signal: SessionSignal): void;
  /** Receive the signals of one scope; a process subscribes only to the scopes it acts on. */
  subscribe(scope: SessionSignalScope, listener: (signal: SessionSignal) => void): () => void;
}

export class RedisSessionSignals implements SessionSignals {
  private readonly subscriber: RedisClient;
  private readonly listeners = { control: new Set<(signal: SessionSignal) => void>(), output: new Set<(signal: SessionSignal) => void>() };
  private readonly channels: Record<SessionSignalScope, string>;
  /** Scopes with a listener; only their channels are subscribed. */
  private readonly subscribed = new Set<SessionSignalScope>();
  constructor(private readonly publisher: RedisClient, namespace = "oma") {
    this.channels = { control: `${namespace}:session-control`, output: `${namespace}:session-output` };
    this.subscriber = publisher.duplicate({ lazyConnect: true });
    this.subscriber.on("error", () => {});
    // Retry subscription on every reconnect, including an unavailable first boot.
    this.subscriber.on("ready", () => {
      for (const scope of this.subscribed) this.subscribeChannel(scope);
    });
    this.subscriber.on("message", (channel, raw) => {
      const scope = channel === this.channels.control ? "control" : channel === this.channels.output ? "output" : undefined;
      if (!scope) return;
      try {
        const signal = JSON.parse(raw) as SessionSignal;
        if (typeof signal.sessionId !== "string") return;
        for (const listener of this.listeners[scope]) listener(signal);
      } catch { /* Invalid transient messages cannot take down execution. */ }
    });
    void this.subscriber.connect().catch(() => {});
  }
  publish(signal: SessionSignal): void {
    // Never queue unbounded notifications during outages or wait for Redis on
    // the durable acceptance / execution path. PG scanning closes this window.
    if (this.publisher.status !== "ready") return;
    void this.publisher.publish(this.channels[sessionSignalScope(signal.kind)], JSON.stringify(signal)).catch(() => {});
  }
  subscribe(scope: SessionSignalScope, listener: (signal: SessionSignal) => void): () => void {
    this.listeners[scope].add(listener);
    if (!this.subscribed.has(scope)) {
      this.subscribed.add(scope);
      if (this.subscriber.status === "ready") this.subscribeChannel(scope);
    }
    return () => { this.listeners[scope].delete(listener); };
  }
  close(): void { this.listeners.control.clear(); this.listeners.output.clear(); this.subscriber.disconnect(); }
  private subscribeChannel(scope: SessionSignalScope): void {
    void this.subscriber.subscribe(this.channels[scope]).catch(() => {});
  }
}
