import type {
  PendingEvent,
  PendingEventStore,
  PendingEventEnqueueInput,
} from "@oma-server/store";

export class InMemoryPendingEventStore implements PendingEventStore {
  private queues: Map<string, PendingEvent[]> = new Map();
  private nextId = 1;

  async enqueue(sessionId: string, event: PendingEventEnqueueInput): Promise<PendingEvent> {
    const pending: PendingEvent = {
      id: `pending_${this.nextId++}`,
      sessionId,
      type: event.type,
      data: event.data,
      sessionThreadId: event.sessionThreadId,
      arrivedAt: new Date(),
    };
    const queue = this.queues.get(sessionId) ?? [];
    queue.push(pending);
    this.queues.set(sessionId, queue);
    return pending;
  }

  async dequeue(sessionId: string): Promise<PendingEvent | null> {
    const queue = this.queues.get(sessionId) ?? [];
    if (queue.length === 0) return null;
    return queue.shift()!;
  }

  async peek(sessionId: string): Promise<PendingEvent | null> {
    const queue = this.queues.get(sessionId) ?? [];
    return queue[0] ?? null;
  }

  async count(sessionId: string): Promise<number> {
    const queue = this.queues.get(sessionId) ?? [];
    return queue.length;
  }
}
