import type { Collection, Db } from "mongodb";
import { nanoid } from "nanoid";
import type { PendingEvent, PendingEventEnqueueInput, PendingEventStore } from "../interfaces/pending-event-store.js";

interface PendingDoc {
  _id: string;
  sessionId: string;
  type: string;
  data: unknown;
  sessionThreadId: string;
  arrivedAt: Date;
}

function docToEvent(doc: PendingDoc): PendingEvent {
  return {
    id: doc._id,
    sessionId: doc.sessionId,
    type: doc.type,
    data: doc.data,
    sessionThreadId: doc.sessionThreadId,
    arrivedAt: doc.arrivedAt,
  };
}

export class MongoPendingEventStore implements PendingEventStore {
  private pending: Collection<PendingDoc>;

  constructor(db: Db) {
    this.pending = db.collection<PendingDoc>("pending_events");
  }

  async ensureIndexes(): Promise<void> {
    await this.pending.createIndex({ sessionId: 1, arrivedAt: 1 });
  }

  async enqueue(sessionId: string, event: PendingEventEnqueueInput): Promise<PendingEvent> {
    const doc: PendingDoc = {
      _id: nanoid(),
      sessionId,
      type: event.type,
      data: event.data,
      sessionThreadId: event.sessionThreadId,
      arrivedAt: new Date(),
    };
    await this.pending.insertOne(doc);
    return docToEvent(doc);
  }

  async dequeue(sessionId: string): Promise<PendingEvent | null> {
    const doc = await this.pending.findOneAndDelete(
      { sessionId },
      { sort: { arrivedAt: 1 } },
    );
    return doc ? docToEvent(doc) : null;
  }

  async peek(sessionId: string): Promise<PendingEvent | null> {
    const doc = await this.pending.findOne(
      { sessionId },
      { sort: { arrivedAt: 1 } },
    );
    return doc ? docToEvent(doc) : null;
  }

  async count(sessionId: string): Promise<number> {
    return this.pending.countDocuments({ sessionId });
  }
}
