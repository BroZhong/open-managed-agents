import type { AgentStore } from "../interfaces/agent-store.js";
import type { AgentFileStore } from "../interfaces/agent-file-store.js";
import type { SkillStore } from "../interfaces/skill-store.js";
import type { SessionStore } from "../interfaces/session-store.js";
import type { WorkspaceMetadataStore } from "../interfaces/workspace-metadata-store.js";
import type { UserStore } from "../interfaces/user-store.js";
import type { Pool } from "./connection.js";
import { DEFAULT_SCHEMA } from "./connection.js";
import { ensureSchema } from "./schema.js";
import { PgAgentStore } from "./agent-store.js";
import { PgAgentFileStore } from "./agent-file-store.js";
import { PgSkillStore } from "./skill-store.js";
import { PgApiKeyStore } from "./api-key-store.js";
import { PgEventLogStore } from "./event-log-store.js";
import { PgPendingEventStore } from "./pending-event-store.js";
import { PgSessionStore } from "./session-store.js";
import { PgWorkspaceMetadataStore } from "./workspace-metadata-store.js";
import { PgUserStore } from "./user-store.js";

export { createPgPool, pgConfigFromEnv, DEFAULT_SCHEMA } from "./connection.js";
export type { Pool, PoolClient, PgConnectionConfig } from "./connection.js";
export { ensureSchema, schemaDdl } from "./schema.js";
export { PgAgentStore } from "./agent-store.js";
export { PgAgentFileStore } from "./agent-file-store.js";
export { PgSkillStore } from "./skill-store.js";
export { PgSessionStore } from "./session-store.js";
export { PgEventLogStore } from "./event-log-store.js";
export { PgPendingEventStore } from "./pending-event-store.js";
export { PgApiKeyStore } from "./api-key-store.js";
export { PgUserStore } from "./user-store.js";
export { PgWorkspaceMetadataStore } from "./workspace-metadata-store.js";

export interface PgStores {
  agentStore: AgentStore;
  agentFileStore: AgentFileStore;
  skillStore: SkillStore;
  sessionStore: SessionStore;
  eventLogStore: PgEventLogStore;
  pendingEventStore: PgPendingEventStore;
  /**
   * Concrete `PgApiKeyStore` (not just the `ApiKeyStore` interface) so callers
   * can reach `findByKeyHash`, which the API auth middleware needs. Mirrors how
   * `MemoryStores` exposes the concrete `InMemoryApiKeyStore`.
   */
  apiKeyStore: PgApiKeyStore;
  userStore: UserStore;
  workspaceStore: WorkspaceMetadataStore;
}

export interface CreatePgStoresOpts {
  /** Run the DDL to create the schema + tables if missing. Defaults to true. */
  ensureSchema?: boolean;
  /** Schema to create when `ensureSchema` runs. Defaults to "oma". */
  schema?: string;
}

export async function createPgStores(pool: Pool, opts: CreatePgStoresOpts = {}): Promise<PgStores> {
  if (opts.ensureSchema !== false) {
    await ensureSchema(pool, opts.schema ?? DEFAULT_SCHEMA);
  }

  return {
    agentStore: new PgAgentStore(pool),
    agentFileStore: new PgAgentFileStore(pool),
    skillStore: new PgSkillStore(pool),
    sessionStore: new PgSessionStore(pool),
    eventLogStore: new PgEventLogStore(pool),
    pendingEventStore: new PgPendingEventStore(pool),
    apiKeyStore: new PgApiKeyStore(pool),
    userStore: new PgUserStore(pool),
    workspaceStore: new PgWorkspaceMetadataStore(pool),
  };
}
