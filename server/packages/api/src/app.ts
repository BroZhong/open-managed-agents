import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AgentStore, AgentFileStore, ApiKeyStore as FullApiKeyStore, ArtifactStore, EventLogStore, PendingEventStore, SessionStore, SkillStore, SkillArtifactStore, WorkspaceStore } from "@oma-server/store";
import type { EventStreamHub } from "@oma-server/event-log";
import type { TurnStreamStore } from "@oma-server/redis";
import type { SessionRouter } from "@oma-server/session-router";
import type { ApiKeyStore, TenantContext } from "./types.js";
import { authMiddleware } from "./middleware/auth.js";
import { agentRoutes } from "./routes/agents.js";
import { agentFileRoutes } from "./routes/agent-files.js";
import { skillRoutes } from "./routes/skills.js";
import { apiKeyRoutes } from "./routes/api-keys.js";
import { sessionRoutes } from "./routes/sessions.js";
import { eventRoutes } from "./routes/events.js";
import { messageRoutes } from "./routes/messages.js";
import { workspaceRoutes } from "./routes/workspace.js";
import { workspaceEntityRoutes } from "./routes/workspaces.js";

type Env = {
  Variables: {
    tenant: TenantContext;
  };
};

export interface AppDeps {
  apiKeyStore: ApiKeyStore;
  fullApiKeyStore?: FullApiKeyStore;
  agentStore?: AgentStore;
  agentFileStore?: AgentFileStore;
  skillStore?: SkillStore;
  skillArtifactStore?: SkillArtifactStore;
  sessionStore?: SessionStore;
  eventLogStore?: EventLogStore;
  pendingEventStore?: PendingEventStore;
  workspaceStore?: WorkspaceStore;
  artifactStore?: ArtifactStore;
  eventStreamHub?: EventStreamHub;
  turnStreamStore?: TurnStreamStore;
  sessionRouter?: SessionRouter;
}

export function createApp(deps: AppDeps) {
  const app = new Hono<Env>();

  // CORS middleware — allow all origins in dev
  app.use("*", cors());

  // Health check — no auth required
  app.get("/health", (c) => {
    return c.json({ status: "ok" });
  });

  // Auth middleware on all /v1/* routes
  app.use("/v1/*", authMiddleware(deps.apiKeyStore));

  // Mount agent routes
  if (deps.agentStore) {
    app.route("", agentRoutes(deps.agentStore));
  }

  // Mount Agent Files routes (per-Agent editable persona/instruction docs)
  if (deps.agentFileStore && deps.agentStore) {
    app.route("", agentFileRoutes(deps.agentFileStore, deps.agentStore));
  }

  // Mount Skill Library routes (tenant-scoped reusable Skills)
  if (deps.skillStore && deps.skillArtifactStore) {
    app.route("", skillRoutes(deps.skillStore, deps.skillArtifactStore));
  }

  // Mount API key CRUD routes
  if (deps.fullApiKeyStore) {
    app.route("", apiKeyRoutes(deps.fullApiKeyStore));
  }

  // Mount Workspace entity routes (create-named + list + get)
  if (deps.workspaceStore) {
    app.route("", workspaceEntityRoutes(deps.workspaceStore));
  }

  // Mount session routes
  if (deps.sessionStore && deps.agentStore && deps.workspaceStore) {
    app.route("", sessionRoutes({
      sessionStore: deps.sessionStore,
      agentStore: deps.agentStore,
      workspaceStore: deps.workspaceStore,
      sessionRouter: deps.sessionRouter,
    }));
  }

  // Mount event routes
  if (deps.eventLogStore && deps.pendingEventStore && deps.sessionStore) {
    app.route("", eventRoutes({
      eventLogStore: deps.eventLogStore,
      pendingEventStore: deps.pendingEventStore,
      sessionStore: deps.sessionStore,
      eventStreamHub: deps.eventStreamHub,
      turnStreamStore: deps.turnStreamStore,
      sessionRouter: deps.sessionRouter,
    }));
  }

  // Mount Workspace file proxy routes (list + preview/download through the Host)
  if (deps.sessionStore && deps.artifactStore) {
    app.route("", workspaceRoutes({
      sessionStore: deps.sessionStore,
      artifactStore: deps.artifactStore,
    }));
  }

  // Mount message routes
  if (deps.eventLogStore && deps.pendingEventStore && deps.sessionStore && deps.eventStreamHub && deps.sessionRouter) {
    app.route("", messageRoutes({
      eventLogStore: deps.eventLogStore,
      pendingEventStore: deps.pendingEventStore,
      sessionStore: deps.sessionStore,
      eventStreamHub: deps.eventStreamHub,
      sessionRouter: deps.sessionRouter,
    }));
  }

  return app;
}
