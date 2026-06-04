import type { Db } from "mongodb";
import type { AgentStore } from "../interfaces/agent-store.js";
import type { ApiKeyStore } from "../interfaces/api-key-store.js";
import type { EventLogStore } from "../interfaces/event-log-store.js";
import type { PendingEventStore } from "../interfaces/pending-event-store.js";
import type { SessionStore } from "../interfaces/session-store.js";
import { MongoAgentStore } from "./agent-store.js";
import { MongoApiKeyStore } from "./api-key-store.js";
import { MongoEventLogStore } from "./event-log-store.js";
import { MongoPendingEventStore } from "./pending-event-store.js";
import { MongoSessionStore } from "./session-store.js";

export { createMongoClient } from "./connection.js";
export { MongoAgentStore } from "./agent-store.js";
export { MongoSessionStore } from "./session-store.js";
export { MongoEventLogStore } from "./event-log-store.js";
export { MongoPendingEventStore } from "./pending-event-store.js";
export { MongoApiKeyStore } from "./api-key-store.js";

export interface MongoStores {
  agentStore: AgentStore;
  sessionStore: SessionStore;
  eventLogStore: EventLogStore;
  pendingEventStore: PendingEventStore;
  apiKeyStore: ApiKeyStore;
}

export async function createMongoStores(db: Db): Promise<MongoStores> {
  const agentStore = new MongoAgentStore(db);
  const sessionStore = new MongoSessionStore(db);
  const eventLogStore = new MongoEventLogStore(db);
  const pendingEventStore = new MongoPendingEventStore(db);
  const apiKeyStore = new MongoApiKeyStore(db);

  await eventLogStore.ensureIndexes();
  await pendingEventStore.ensureIndexes();
  await apiKeyStore.ensureIndexes();

  return { agentStore, sessionStore, eventLogStore, pendingEventStore, apiKeyStore };
}
