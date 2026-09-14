import { InMemoryAgentStore } from "./agent-store.js";
import { InMemoryAgentFileStore } from "./agent-file-store.js";
import { InMemorySkillStore } from "./skill-store.js";
import { InMemorySkillArtifactStore } from "./skill-artifact-store.js";
import { InMemoryArtifactStore } from "./artifact-store.js";
import { InMemorySessionStore } from "./session-store.js";
import { InMemoryEventLogStore } from "./event-log-store.js";
import { InMemoryPendingEventStore } from "./pending-event-store.js";
import { InMemoryApiKeyStore } from "./api-key-store.js";
import { InMemoryUserStore } from "./user-store.js";
import { InMemoryWorkspaceMetadataStore } from "./workspace-metadata-store.js";
import { InMemoryLoopStore } from "./loop-store.js";

export { InMemoryAgentStore } from "./agent-store.js";
export { InMemoryAgentFileStore } from "./agent-file-store.js";
export { InMemorySkillStore } from "./skill-store.js";
export { InMemorySkillArtifactStore } from "./skill-artifact-store.js";
export { InMemoryArtifactStore } from "./artifact-store.js";
export { InMemorySessionStore } from "./session-store.js";
export { InMemoryEventLogStore } from "./event-log-store.js";
export { InMemoryPendingEventStore } from "./pending-event-store.js";
export { InMemoryApiKeyStore } from "./api-key-store.js";
export { InMemoryUserStore } from "./user-store.js";
export { InMemoryWorkspaceMetadataStore } from "./workspace-metadata-store.js";
export { InMemoryLoopStore } from "./loop-store.js";

export interface MemoryStores {
  agentStore: InMemoryAgentStore;
  agentFileStore: InMemoryAgentFileStore;
  skillStore: InMemorySkillStore;
  skillArtifactStore: InMemorySkillArtifactStore;
  artifactStore: InMemoryArtifactStore;
  sessionStore: InMemorySessionStore;
  eventLogStore: InMemoryEventLogStore;
  pendingEventStore: InMemoryPendingEventStore;
  apiKeyStore: InMemoryApiKeyStore;
  userStore: InMemoryUserStore;
  workspaceStore: InMemoryWorkspaceMetadataStore;
  loopStore: InMemoryLoopStore;
}

export function createMemoryStores(): MemoryStores {
  let sessionStore!: InMemorySessionStore;
  const pendingEventStore = new InMemoryPendingEventStore(async (sessionId) => {
    const session = await sessionStore.getById(sessionId);
    return Boolean(session && session.status !== "terminated");
  });
  sessionStore = new InMemorySessionStore((sessionId, fence) =>
    pendingEventStore.ownsClaim(sessionId, fence.eventId, fence));
  const eventLogStore = new InMemoryEventLogStore(
    (sessionId, fence) => pendingEventStore.ownsClaim(sessionId, fence.eventId, fence),
    async (sessionId) => {
      const session = await sessionStore.getById(sessionId);
      return Boolean(session && session.status !== "terminated");
    },
  );
  const agentStore = new InMemoryAgentStore();
  const workspaceStore = new InMemoryWorkspaceMetadataStore();
  const loopStore = new InMemoryLoopStore(
    agentStore,
    sessionStore,
    workspaceStore,
    pendingEventStore,
  );
  return {
    agentStore,
    agentFileStore: new InMemoryAgentFileStore(),
    skillStore: new InMemorySkillStore(),
    skillArtifactStore: new InMemorySkillArtifactStore(),
    artifactStore: new InMemoryArtifactStore(),
    sessionStore,
    eventLogStore,
    pendingEventStore,
    apiKeyStore: new InMemoryApiKeyStore(),
    userStore: new InMemoryUserStore(),
    workspaceStore,
    loopStore,
  };
}
