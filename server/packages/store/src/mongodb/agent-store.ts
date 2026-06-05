import type { Collection, Db } from "mongodb";
import { nanoid } from "nanoid";
import type { AgentStore, AgentStoreCreateInput, AgentStoreListOpts, AgentStoreUpdateInput } from "../interfaces/agent-store.js";
import type { Agent, PaginatedResult } from "../types.js";

interface AgentDoc {
  _id: string;
  tenantId: string;
  name: string;
  model: string;
  system: string;
  runtime: Agent["runtime"];
  tools?: Agent["tools"];
  mcpServers?: Agent["mcpServers"];
  skills?: Agent["skills"];
  sandbox?: Agent["sandbox"];
  createdAt: Date;
  updatedAt: Date;
}

function docToAgent(doc: AgentDoc): Agent {
  return {
    id: doc._id,
    tenantId: doc.tenantId,
    name: doc.name,
    model: doc.model,
    system: doc.system,
    runtime: doc.runtime,
    tools: doc.tools,
    mcpServers: doc.mcpServers,
    skills: doc.skills,
    sandbox: doc.sandbox,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export class MongoAgentStore implements AgentStore {
  private collection: Collection<AgentDoc>;

  constructor(db: Db) {
    this.collection = db.collection<AgentDoc>("agents");
  }

  async create(input: AgentStoreCreateInput): Promise<Agent> {
    const now = new Date();
    const doc: AgentDoc = {
      _id: `agent_${nanoid()}`,
      tenantId: input.tenantId,
      name: input.name,
      model: input.model,
      system: input.system,
      runtime: input.runtime,
      tools: input.tools,
      mcpServers: input.mcpServers,
      skills: input.skills,
      sandbox: input.sandbox,
      createdAt: now,
      updatedAt: now,
    };
    await this.collection.insertOne(doc);
    return docToAgent(doc);
  }

  async getById(id: string): Promise<Agent | null> {
    const doc = await this.collection.findOne({ _id: id });
    return doc ? docToAgent(doc) : null;
  }

  async list(tenantId: string, opts?: AgentStoreListOpts): Promise<PaginatedResult<Agent>> {
    const limit = opts?.limit ?? 20;
    const filter: Record<string, unknown> = { tenantId };
    if (opts?.cursor) {
      filter._id = { $gt: opts.cursor };
    }
    const docs = await this.collection
      .find(filter)
      .sort({ _id: 1 })
      .limit(limit + 1)
      .toArray();

    const hasMore = docs.length > limit;
    const data = (hasMore ? docs.slice(0, limit) : docs).map(docToAgent);
    return { data, hasMore };
  }

  async update(id: string, input: AgentStoreUpdateInput): Promise<Agent | null> {
    const setFields: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) setFields.name = input.name;
    if (input.model !== undefined) setFields.model = input.model;
    if (input.system !== undefined) setFields.system = input.system;
    if (input.runtime !== undefined) setFields.runtime = input.runtime;
    if (input.tools !== undefined) setFields.tools = input.tools;
    if (input.mcpServers !== undefined) setFields.mcpServers = input.mcpServers;
    if (input.skills !== undefined) setFields.skills = input.skills;
    if (input.sandbox !== undefined) setFields.sandbox = input.sandbox;

    const result = await this.collection.findOneAndUpdate(
      { _id: id },
      { $set: setFields },
      { returnDocument: "after" },
    );
    return result ? docToAgent(result) : null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.collection.deleteOne({ _id: id });
    return result.deletedCount === 1;
  }
}
