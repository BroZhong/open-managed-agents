import { InMemoryAgentStore } from "./agent-store.js";
import { InMemoryAgentFileStore } from "./agent-file-store.js";
import { InMemorySkillStore } from "./skill-store.js";
import { InMemorySkillArtifactStore } from "./skill-artifact-store.js";
import { InMemorySessionStore } from "./session-store.js";
import { InMemoryEventLogStore } from "./event-log-store.js";
import { InMemoryPendingEventStore } from "./pending-event-store.js";
import { InMemoryApiKeyStore } from "./api-key-store.js";
import { InMemoryWorkspaceStore } from "./workspace-store.js";

export { InMemoryAgentStore } from "./agent-store.js";
export { InMemoryAgentFileStore } from "./agent-file-store.js";
export { InMemorySkillStore } from "./skill-store.js";
export { InMemorySkillArtifactStore } from "./skill-artifact-store.js";
export { InMemorySessionStore } from "./session-store.js";
export { InMemoryEventLogStore } from "./event-log-store.js";
export { InMemoryPendingEventStore } from "./pending-event-store.js";
export { InMemoryApiKeyStore } from "./api-key-store.js";
export { InMemoryWorkspaceStore } from "./workspace-store.js";

export interface MemoryStores {
  agentStore: InMemoryAgentStore;
  agentFileStore: InMemoryAgentFileStore;
  skillStore: InMemorySkillStore;
  skillArtifactStore: InMemorySkillArtifactStore;
  sessionStore: InMemorySessionStore;
  eventLogStore: InMemoryEventLogStore;
  pendingEventStore: InMemoryPendingEventStore;
  apiKeyStore: InMemoryApiKeyStore;
  workspaceStore: InMemoryWorkspaceStore;
}

export function createMemoryStores(): MemoryStores {
  return {
    agentStore: new InMemoryAgentStore(),
    agentFileStore: new InMemoryAgentFileStore(),
    skillStore: new InMemorySkillStore(),
    skillArtifactStore: new InMemorySkillArtifactStore(),
    sessionStore: new InMemorySessionStore(),
    eventLogStore: new InMemoryEventLogStore(),
    pendingEventStore: new InMemoryPendingEventStore(),
    apiKeyStore: new InMemoryApiKeyStore(),
    workspaceStore: new InMemoryWorkspaceStore(),
  };
}
