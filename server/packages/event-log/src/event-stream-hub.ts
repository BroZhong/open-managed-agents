export interface StreamEvent {
  type: string;
  seq?: number;
  data: unknown;
}

export interface StreamChunk {
  type: string;
  data: unknown;
  /**
   * The turn this delta belongs to. Emitted on the SSE frame so a reconnecting
   * client can align live deltas to the Redis-backfilled ones and to the full
   * Event they roll up into.
   */
  turnId?: string;
  /** Which content block within the turn (see TurnDelta.blockIndex). */
  blockIndex?: number;
  /**
   * The Redis stream entry id this delta was written under. Emitted so a
   * reconnecting client can skip live deltas already covered by the Redis
   * backfill (dedup by "entry id <= max backfilled id").
   */
  deltaId?: string;
}

export interface SubscribeOpts {
  includeChunks?: boolean;
}

export interface Subscription {
  stream: ReadableStream<string>;
  unsubscribe: () => void;
}

export interface EventStreamHub {
  publish(sessionId: string, event: StreamEvent): void;
  publishChunk(sessionId: string, chunk: StreamChunk): void;
  subscribe(sessionId: string, opts?: SubscribeOpts): Subscription;
}

interface Subscriber {
  controller: ReadableStreamDefaultController<string>;
  includeChunks: boolean;
}

/**
 * Build the SSE `data` payload for a delta frame: the raw stream event with
 * `turnId` + `blockIndex` merged in for alignment. Used by both the live hub
 * and the server-side reconnect backfill so live and backfilled delta frames
 * are byte-identical to the client.
 */
export function alignedChunkData(opts: {
  data: unknown;
  turnId?: string;
  blockIndex?: number;
  deltaId?: string;
}): Record<string, unknown> {
  const base =
    opts.data && typeof opts.data === "object"
      ? (opts.data as Record<string, unknown>)
      : { value: opts.data };
  const out: Record<string, unknown> = { ...base };
  if (opts.turnId !== undefined) out.turnId = opts.turnId;
  if (opts.blockIndex !== undefined) out.blockIndex = opts.blockIndex;
  if (opts.deltaId !== undefined) out.deltaId = opts.deltaId;
  return out;
}

function withAlignment(chunk: StreamChunk): Record<string, unknown> {
  return alignedChunkData(chunk);
}

function formatSSEFrame(opts: { event: string; id?: string; data: string }): string {
  let frame = `event: ${opts.event}\n`;
  if (opts.id !== undefined) {
    frame += `id: ${opts.id}\n`;
  }
  frame += `data: ${opts.data}\n\n`;
  return frame;
}

export class InProcessEventStreamHub implements EventStreamHub {
  private sessions = new Map<string, Set<Subscriber>>();

  publish(sessionId: string, event: StreamEvent): void {
    const subscribers = this.sessions.get(sessionId);
    if (!subscribers || subscribers.size === 0) return;

    const frame = formatSSEFrame({
      event: event.type,
      id: event.seq !== undefined ? String(event.seq) : undefined,
      data: JSON.stringify(event.data),
    });

    for (const sub of subscribers) {
      sub.controller.enqueue(frame);
    }
  }

  publishChunk(sessionId: string, chunk: StreamChunk): void {
    const subscribers = this.sessions.get(sessionId);
    if (!subscribers || subscribers.size === 0) return;

    const frame = formatSSEFrame({
      event: chunk.type,
      data: JSON.stringify(withAlignment(chunk)),
    });

    for (const sub of subscribers) {
      if (sub.includeChunks) {
        sub.controller.enqueue(frame);
      }
    }
  }

  subscribe(sessionId: string, opts?: SubscribeOpts): Subscription {
    const includeChunks = opts?.includeChunks ?? false;

    let subscriber: Subscriber;

    const stream = new ReadableStream<string>({
      start: (controller) => {
        subscriber = { controller, includeChunks };

        let sessionSubs = this.sessions.get(sessionId);
        if (!sessionSubs) {
          sessionSubs = new Set();
          this.sessions.set(sessionId, sessionSubs);
        }
        sessionSubs.add(subscriber);
      },
      cancel: () => {
        this.removeSubscriber(sessionId, subscriber);
      },
    });

    const unsubscribe = () => {
      this.removeSubscriber(sessionId, subscriber);
      try {
        subscriber.controller.close();
      } catch {
        // already closed
      }
    };

    return { stream, unsubscribe };
  }

  private removeSubscriber(sessionId: string, subscriber: Subscriber): void {
    const sessionSubs = this.sessions.get(sessionId);
    if (sessionSubs) {
      sessionSubs.delete(subscriber);
      if (sessionSubs.size === 0) {
        this.sessions.delete(sessionId);
      }
    }
  }
}
