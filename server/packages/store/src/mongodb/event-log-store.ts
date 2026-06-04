import type { Collection, Db } from "mongodb";
import type { EventLogStore, EventLogStoreAppendInput, EventLogStoreGetEventsOpts } from "../interfaces/event-log-store.js";
import type { PaginatedResult, StoredEvent } from "../types.js";

interface EventDoc {
  sessionId: string;
  seq: number;
  type: string;
  data: unknown;
  ts: Date;
  sessionThreadId: string;
}

interface CounterDoc {
  _id: string;
  seq: number;
}

function docToEvent(doc: EventDoc): StoredEvent {
  return {
    sessionId: doc.sessionId,
    seq: doc.seq,
    type: doc.type,
    data: doc.data,
    ts: doc.ts,
    sessionThreadId: doc.sessionThreadId,
  };
}

export class MongoEventLogStore implements EventLogStore {
  private events: Collection<EventDoc>;
  private counters: Collection<CounterDoc>;

  constructor(db: Db) {
    this.events = db.collection<EventDoc>("events");
    this.counters = db.collection<CounterDoc>("counters");
  }

  async ensureIndexes(): Promise<void> {
    await this.events.createIndex({ sessionId: 1, seq: 1 }, { unique: true });
  }

  async append(sessionId: string, event: EventLogStoreAppendInput): Promise<StoredEvent> {
    // Atomically increment the sequence counter for this session
    const counter = await this.counters.findOneAndUpdate(
      { _id: sessionId },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: "after" },
    );

    const seq = counter!.seq;
    const doc: EventDoc = {
      sessionId,
      seq,
      type: event.type,
      data: event.data,
      ts: new Date(),
      sessionThreadId: event.sessionThreadId,
    };

    await this.events.insertOne(doc);
    return docToEvent(doc);
  }

  async getEvents(sessionId: string, opts?: EventLogStoreGetEventsOpts): Promise<PaginatedResult<StoredEvent>> {
    const limit = opts?.limit ?? 50;
    const filter: Record<string, unknown> = { sessionId };
    if (opts?.afterSeq !== undefined) {
      filter.seq = { $gt: opts.afterSeq };
    }

    const docs = await this.events
      .find(filter)
      .sort({ seq: 1 })
      .limit(limit + 1)
      .toArray();

    const hasMore = docs.length > limit;
    const data = (hasMore ? docs.slice(0, limit) : docs).map(docToEvent);
    return { data, hasMore };
  }

}
