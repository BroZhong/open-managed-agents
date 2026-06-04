import type { Collection, Db } from "mongodb";
import { nanoid } from "nanoid";
import type { SessionStore, SessionStoreCreateInput, SessionStoreListOpts } from "../interfaces/session-store.js";
import type { Agent, PaginatedResult, Session, SessionStatus } from "../types.js";

interface SessionDoc {
  _id: string;
  tenantId: string;
  agentId: string;
  status: SessionStatus;
  agent: Agent;
  createdAt: Date;
  updatedAt: Date;
  terminatedAt?: Date;
}

function docToSession(doc: SessionDoc): Session {
  return {
    id: doc._id,
    tenantId: doc.tenantId,
    agentId: doc.agentId,
    status: doc.status,
    agent: doc.agent,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    terminatedAt: doc.terminatedAt,
  };
}

export class MongoSessionStore implements SessionStore {
  private collection: Collection<SessionDoc>;

  constructor(db: Db) {
    this.collection = db.collection<SessionDoc>("sessions");
  }

  async create(input: SessionStoreCreateInput): Promise<Session> {
    const now = new Date();
    const doc: SessionDoc = {
      _id: `sess_${nanoid()}`,
      tenantId: input.tenantId,
      agentId: input.agentId,
      status: "idle",
      agent: input.agent,
      createdAt: now,
      updatedAt: now,
    };
    await this.collection.insertOne(doc);
    return docToSession(doc);
  }

  async getById(id: string): Promise<Session | null> {
    const doc = await this.collection.findOne({ _id: id });
    return doc ? docToSession(doc) : null;
  }

  async list(tenantId: string, opts?: SessionStoreListOpts): Promise<PaginatedResult<Session>> {
    const limit = opts?.limit ?? 20;
    const filter: Record<string, unknown> = { tenantId };
    if (opts?.cursor) {
      filter._id = { $gt: opts.cursor };
    }
    if (opts?.agentId) {
      filter.agentId = opts.agentId;
    }
    if (opts?.status) {
      filter.status = opts.status;
    }

    const docs = await this.collection
      .find(filter)
      .sort({ _id: 1 })
      .limit(limit + 1)
      .toArray();

    const hasMore = docs.length > limit;
    const data = (hasMore ? docs.slice(0, limit) : docs).map(docToSession);
    return { data, hasMore };
  }

  async updateStatus(id: string, status: SessionStatus): Promise<Session | null> {
    const result = await this.collection.findOneAndUpdate(
      { _id: id },
      { $set: { status, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    return result ? docToSession(result) : null;
  }

  async terminate(id: string): Promise<Session | null> {
    const now = new Date();
    const result = await this.collection.findOneAndUpdate(
      { _id: id },
      { $set: { status: "terminated" as SessionStatus, updatedAt: now, terminatedAt: now } },
      { returnDocument: "after" },
    );
    return result ? docToSession(result) : null;
  }
}
