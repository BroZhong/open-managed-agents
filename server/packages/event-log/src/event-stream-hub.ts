export interface StreamEvent {
  type: string;
  seq?: number;
  data: unknown;
}

export interface StreamChunk {
  type: string;
  data: unknown;
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
      data: JSON.stringify(chunk.data),
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
