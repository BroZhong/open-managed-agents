import type { SessionSignals } from "@oma-server/redis";
import { InProcessEventStreamHub, type EventStreamHub, type StreamChunk, type StreamEvent, type SubscribeOpts } from "./event-stream-hub.js";

/** Redis connects processes; the local hub only fans out to this API's sockets. */
export class RedisEventStreamHub implements EventStreamHub {
  private readonly local = new InProcessEventStreamHub();
  private readonly unsubscribe: () => void;
  /**
   * `relay: false` only publishes: a Runner has no live streams, so it never
   * receives the fleet's output signals (ADR-0018).
   */
  constructor(private readonly signals: SessionSignals, { relay = true }: { relay?: boolean } = {}) {
    this.unsubscribe = relay ? signals.subscribe("output", signal => {
      if (signal.kind === "durable") this.local.publish(signal.sessionId, { type: "oma.durable", data: {} });
      if (signal.kind === "chunk" && signal.chunk) this.local.publishChunk(signal.sessionId, signal.chunk);
    }) : () => {};
  }
  publish(sessionId: string, _event: StreamEvent): void { this.signals.publish({ sessionId, kind: "durable" }); }
  publishChunk(sessionId: string, chunk: StreamChunk): void { this.signals.publish({ sessionId, kind: "chunk", chunk }); }
  subscribe(sessionId: string, opts?: SubscribeOpts) { return this.local.subscribe(sessionId, opts); }
  close(): void { this.unsubscribe(); }
}
