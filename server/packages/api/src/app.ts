import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AgentStore, AgentFileStore, ApiKeyStore as FullApiKeyStore, ArtifactStore, EventLogIngressStore, LoopStore, PendingEventIngressStore, SessionStore, SkillStore, SkillArtifactStore, UserStore, WorkspaceMetadataStore } from "@oma-server/store";
import type { EventStreamHub } from "@oma-server/event-log";
import type { TurnStreamStore } from "@oma-server/redis";
import type { SessionRouter } from "@oma-server/session-router";
import type { ApiKeyStore, TenantContext } from "./types.js";
import { authMiddleware } from "./middleware/auth.js";
import { agentRoutes } from "./routes/agents.js";
import { agentFileRoutes } from "./routes/agent-files.js";
import { agentSkillRoutes } from "./routes/agent-skills.js";
import { skillRoutes } from "./routes/skills.js";
import { apiKeyRoutes } from "./routes/api-keys.js";
import { authRoutes } from "./routes/auth.js";
import { sessionRoutes } from "./routes/sessions.js";
import { eventRoutes } from "./routes/events.js";
import { messageRoutes } from "./routes/messages.js";
import { workspaceRoutes } from "./routes/workspace.js";
import { workspaceEntityRoutes } from "./routes/workspaces.js";
import { mcpCatalogRoutes } from "./routes/mcp-catalog.js";
import { loopRoutes } from "./routes/loops.js";

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
  eventLogStore?: EventLogIngressStore;
  pendingEventStore?: PendingEventIngressStore;
  workspaceStore?: WorkspaceMetadataStore;
  loopStore?: LoopStore;
  userStore?: UserStore;
  artifactStore?: ArtifactStore;
  eventStreamHub?: EventStreamHub;
  turnStreamStore?: TurnStreamStore;
  /** Override the SSE keepalive cadence in focused tests. */
  sseHeartbeatIntervalMs?: number;
  sessionRouter?: SessionRouter;
  /** Deterministic clock seam for Loop API tests. */
  now?: () => Date;
}

export function createApp(deps: AppDeps) {
  const app = new Hono<Env>();

  // CORS middleware — allow all origins in dev
  app.use("*", cors());

  // Health check — no auth required
  app.get("/health", (c) => {
    return c.json({ status: "ok" });
  });

  // Auth routes (register/login) — mounted at /auth/*, OUTSIDE the /v1/* auth
  // middleware so they are reachable unauthenticated.
  if (deps.userStore) {
    app.route("", authRoutes(deps.userStore));
  }

  // Auth middleware on all /v1/* routes
  app.use("/v1/*", authMiddleware(deps.apiKeyStore));

  // Host-owned MCP catalog exposes metadata only; runtime definitions stay private.
  app.route("", mcpCatalogRoutes());

  // Mount agent routes
  if (deps.agentStore) {
    app.route("", agentRoutes(deps.agentStore));
  }

  if (deps.agentStore && deps.loopStore) {
    app.route("", loopRoutes({
      agentStore: deps.agentStore,
      loopStore: deps.loopStore,
      sessionRouter: deps.sessionRouter,
      now: deps.now,
    }));
  }

  // Mount Agent Files routes (per-Agent editable persona/instruction docs)
  if (deps.agentFileStore && deps.agentStore) {
    app.route("", agentFileRoutes(deps.agentFileStore, deps.agentStore));
  }

  // Mount Skill Library routes (tenant-scoped reusable Skills)
  if (deps.skillStore && deps.skillArtifactStore) {
    app.route("", skillRoutes(deps.skillStore, deps.skillArtifactStore));
  }

  // Mount per-Agent Skill routes (equip = fork; unequip = delete fork; ADR-0004)
  if (deps.agentStore && deps.skillStore && deps.skillArtifactStore) {
    app.route("", agentSkillRoutes(deps.agentStore, deps.skillStore, deps.skillArtifactStore));
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
      sseHeartbeatIntervalMs: deps.sseHeartbeatIntervalMs,
      sessionRouter: deps.sessionRouter,
    }));
  }

  // Mount Workspace file proxy routes (list + preview/download through the Host)
  if (deps.sessionStore && deps.artifactStore) {
    app.route("", workspaceRoutes({
      sessionStore: deps.sessionStore,
      artifactStore: deps.artifactStore,
      turnStreamStore: deps.turnStreamStore,
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
