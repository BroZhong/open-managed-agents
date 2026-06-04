export interface PendingEvent {
  id: string;
  sessionId: string;
  type: string;
  data: unknown;
  sessionThreadId: string;
  arrivedAt: Date;
}

export interface PendingEventEnqueueInput {
  type: string;
  data: unknown;
  sessionThreadId: string;
}

export interface PendingEventStore {
  enqueue(sessionId: string, event: PendingEventEnqueueInput): Promise<PendingEvent>;
  dequeue(sessionId: string): Promise<PendingEvent | null>;
  peek(sessionId: string): Promise<PendingEvent | null>;
  count(sessionId: string): Promise<number>;
}
