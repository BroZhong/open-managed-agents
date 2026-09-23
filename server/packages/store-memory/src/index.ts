import { InMemoryModelProviderStore } from "./model-provider-store.js";
export { InMemoryModelProviderStore } from "./model-provider-store.js";
import { InMemorySessionShareStore } from "./session-share-store.js";
export { InMemorySessionShareStore } from "./session-share-store.js";
import { InMemoryDelegationStore } from "./delegation-store.js";
export { InMemoryDelegationStore, MemoryDelegationStore } from "./delegation-store.js";
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
  modelProviderStore: InMemoryModelProviderStore;
  agentStore: InMemoryAgentStore;
  agentFileStore: InMemoryAgentFileStore;
  skillStore: InMemorySkillStore;
  skillArtifactStore: InMemorySkillArtifactStore;
  artifactStore: InMemoryArtifactStore;
  sessionShareStore: InMemorySessionShareStore;
  sessionStore: InMemorySessionStore;
  eventLogStore: InMemoryEventLogStore;
  pendingEventStore: InMemoryPendingEventStore;
  apiKeyStore: InMemoryApiKeyStore;
  userStore: InMemoryUserStore;
  workspaceStore: InMemoryWorkspaceMetadataStore;
  loopStore: InMemoryLoopStore;
  delegationStore: InMemoryDelegationStore;
}

export function createMemoryStores(): MemoryStores {
  let sessionStore!: InMemorySessionStore;
  let eventLogStore!: InMemoryEventLogStore;
  const pendingEventStore = new InMemoryPendingEventStore(async (sessionId) => {
    const session = await sessionStore.getById(sessionId);
    return Boolean(session && session.status !== "terminated");
  }, (sessionId, eventId, queueEmpty) => {
    const session = sessionStore.getRecord(sessionId);
    if (!session || session.status === "terminated") return { accepted: false };
    if (!eventLogStore.hasTurnCompletion(sessionId, eventId)) {
      throw new Error("Cannot acknowledge a Turn without its completion marker");
    }
    if (!queueEmpty) return { accepted: true };
    const idleEvent = eventLogStore.appendUnfenced(sessionId, {
      type: "session.status_idle", data: {}, sessionThreadId: "sthr_primary",
      idempotencyKey: `pending:${eventId}:status_idle`,
    });
    session.status = "idle";
    session.updatedAt = new Date();
    return { accepted: true, idleEvent };
  });
  sessionStore = new InMemorySessionStore((sessionId, fence) =>
    pendingEventStore.ownsClaim(sessionId, fence.eventId, fence));
  eventLogStore = new InMemoryEventLogStore(
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
    modelProviderStore: new InMemoryModelProviderStore(),
    agentStore,
    agentFileStore: new InMemoryAgentFileStore(),
    skillStore: new InMemorySkillStore(),
    skillArtifactStore: new InMemorySkillArtifactStore(),
    artifactStore: new InMemoryArtifactStore(),
    sessionShareStore: new InMemorySessionShareStore(),
    sessionStore,
    eventLogStore,
    pendingEventStore,
    apiKeyStore: new InMemoryApiKeyStore(),
    userStore: new InMemoryUserStore(),
    workspaceStore,
    loopStore,
    delegationStore: new InMemoryDelegationStore(sessionStore, pendingEventStore, eventLogStore, workspaceStore),
  };
}
