import type { OpenAPIHono } from "@hono/zod-openapi";
import type { SessionShareStore, AgentStore, EventLogStore, SessionStore, WorkspaceMetadataStore } from "@oma-server/store";
import { workspaceObjectPrefix } from "@oma-server/store";
import type { SessionRouter } from "@oma-server/session-router";
import type { TenantContext } from "../types.js";
import { publicSession, sharedSession } from "../lib/public-projection.js";
import { tokenUsageToWire } from "../lib/token-usage.js";
import { getOpenApiRoute } from "../openapi/routes.js";
import {
  createContractRouter,
  registerContractRoute,
} from "../openapi/router.js";

type Env = {
  Variables: {
    tenant: TenantContext;
  };
};

export interface SessionRouteDeps {
  sessionShareStore?: SessionShareStore;
  sessionStore: SessionStore;
  agentStore: AgentStore;
  workspaceStore: WorkspaceMetadataStore;
  eventLogStore?: EventLogStore;
  sessionRouter?: SessionRouter;
  wakeSession?: (sessionId: string) => void;
}

export function sessionRoutes(deps: SessionRouteDeps): OpenAPIHono<Env> {
  const router = createContractRouter<Env>();

  registerContractRoute(router, getOpenApiRoute("createSessionShare"), async (c) => {
    const session = await deps.sessionStore.getById(c.req.param("id")!);
    const tenant = c.get("tenant");
    if (!session || session.tenantId !== tenant.tenantId || session.deletedAt) {
      return c.json({ error: "Session not found" }, 404);
    }
    const workspace = await deps.workspaceStore.getById(session.tenantId, session.workspaceId);
    if (!workspace || workspace.deletedAt) return c.json({ error: "Session not found" }, 404);
    if (!deps.sessionShareStore) return c.json({ error: "Sharing unavailable" }, 503);
    c.header("Cache-Control", "no-store");
    const share = await deps.sessionShareStore.getOrCreate(session.id);
    return c.json({ id: share.id });
  });

  registerContractRoute(router, getOpenApiRoute("resolveSessionShare"), (c) => {
    const share = c.get("tenant").share;
    if (!share || share.id !== c.req.param("id")) return c.json({ error: "Share credential required" }, 403);
    return c.json({ sessionId: share.sessionId, workspaceId: share.workspaceId });
  });

  // POST /v1/sessions — Create session
  registerContractRoute(router, getOpenApiRoute("createSession"), async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const agentId = body.agent;
    if (!agentId || typeof agentId !== "string") {
      return c.json({ error: "Missing required field: agent" }, 400);
    }

    // Optional user-supplied Workspace ID (snake_case wire, camelCase alias).
    const workspaceIdInput = body.workspace_id ?? body.workspaceId;
    if (workspaceIdInput !== undefined && typeof workspaceIdInput !== "string") {
      return c.json({ error: "workspace_id must be a string" }, 400);
    }

    // Optional name for an auto-created Workspace (snake_case wire, camelCase
    // alias). Only meaningful when creating a fresh Workspace; on an existing
    // (idempotent) id it is ignored by the store (ON CONFLICT DO NOTHING).
    const workspaceNameInput = body.workspace_name ?? body.workspaceName;
    if (workspaceNameInput !== undefined && typeof workspaceNameInput !== "string") {
      return c.json({ error: "workspace_name must be a string" }, 400);
    }

    const tenant = c.get("tenant");
    if (workspaceIdInput !== undefined) {
      try {
        workspaceObjectPrefix(tenant.tenantId, workspaceIdInput);
      } catch {
        return c.json({ error: "workspace_id must contain 1–128 letters, numbers, underscores or hyphens" }, 400);
      }
    }
    const agent = await deps.agentStore.getById(agentId);
    if (!agent || agent.tenantId !== tenant.tenantId) {
      return c.json({ error: "Agent not found" }, 404);
    }

    // Resolve the Workspace to bind: use the supplied ID as-is (idempotent
    // create), otherwise auto-create one. The Session→Workspace binding is
    // then set immutably at creation.
    const workspace = await deps.workspaceStore.create({
      tenantId: tenant.tenantId,
      id: workspaceIdInput,
      name: workspaceNameInput,
    });

    if (workspace.deletedAt) return c.json({ error: "Workspace has been deleted" }, 409);
    const session = await deps.sessionStore.create({
      tenantId: tenant.tenantId,
      agentId: agent.id,
      agent,
      workspaceId: workspace.id,
    });

    return c.json(publicSession(session), 201);
  });

  // GET /v1/sessions — List sessions
  registerContractRoute(router, getOpenApiRoute("listSessions"), async (c) => {
    const tenant = c.get("tenant");
    const limitParam = c.req.query("limit");
    const cursor = c.req.query("cursor") || undefined;
    const agentId = c.req.query("agent_id") || undefined;
    const status = c.req.query("status") || undefined;
    const loopId = c.req.query("loop_id") || undefined;
    const excludeLoop = c.req.query("exclude_loop");
    const excludeDelegated = c.req.query("exclude_delegated");
    if (excludeDelegated !== undefined && excludeDelegated !== "true" && excludeDelegated !== "false") {
      return c.json({ error: "exclude_delegated must be true or false" }, 400);
    }
    if (excludeLoop !== undefined && excludeLoop !== "true" && excludeLoop !== "false") {
      return c.json({ error: "exclude_loop must be true or false" }, 400);
    }
    if (loopId && excludeLoop === "true") {
      return c.json({ error: "loop_id and exclude_loop=true cannot be combined" }, 400);
    }

    let limit = 50;
    if (limitParam) {
      const parsed = parseInt(limitParam, 10);
      if (!isNaN(parsed) && parsed > 0) {
        limit = Math.min(parsed, 100);
      }
    }

    const workspaces = await deps.workspaceStore.list(tenant.tenantId, true);
    const result = await deps.sessionStore.list(tenant.tenantId, {
      excludedWorkspaceIds: workspaces.filter((w) => w.deletedAt).map((w) => w.id),
      limit,
      cursor,
      agentId,
      status: status as any,
      loopId,
      withoutLoop: excludeLoop === "true",
      excludeDelegated: excludeDelegated === "true",
    });

    const response: Record<string, unknown> = {
      data: result.data.map(publicSession),
      has_more: result.hasMore,
    };

    if (result.hasMore && result.data.length > 0) {
      response.next_cursor = result.data[result.data.length - 1].id;
    }

    return c.json(response);
  });

  // GET /v1/sessions/:id/usage — Aggregate durable model spans
  registerContractRoute(router, getOpenApiRoute("getSessionUsage"), async (c) => {
    const id = c.req.param("id")!;
    const tenant = c.get("tenant");
    const session = await deps.sessionStore.getById(id);
    if (!session || session.tenantId !== tenant.tenantId) {
      return c.json({ error: "Session not found" }, 404);
    }
    if (!deps.eventLogStore) {
      return c.json({ error: "Usage service unavailable" }, 503);
    }

    const usage = await deps.eventLogStore.getUsage({ sessionId: id });
    return c.json({ usage: tokenUsageToWire(usage) });
  });

  // GET /v1/sessions/:id — Get session
  registerContractRoute(router, getOpenApiRoute("getSession"), async (c) => {
    const id = c.req.param("id")!;
    const tenant = c.get("tenant");

    const session = await deps.sessionStore.getById(id);
    if (!session || session.tenantId !== tenant.tenantId || session.deletedAt) {
      return c.json({ error: "Session not found" }, 404);
    }

    const workspace = await deps.workspaceStore.getById(tenant.tenantId, session.workspaceId);
    if (workspace?.deletedAt) return c.json({ error: "Session not found" }, 404);
    return c.json(tenant.share ? sharedSession(session) : publicSession(session));
  });

  registerContractRoute(router, getOpenApiRoute("updateSession"), async (c) => {
    const id = c.req.param("id")!;
    const tenant = c.get("tenant");
    const existing = await deps.sessionStore.getById(id);
    if (!existing || existing.tenantId !== tenant.tenantId || existing.deletedAt) {
      return c.json({ error: "Session not found" }, 404);
    }
    const body = await c.req.json();
    if (body.deleted === true) {
      await deps.sessionStore.softDelete(id);
      return c.json({ type: "session_deleted", id });
    }
    const session = await deps.sessionStore.setTitle(id, body.title.trim());
    return c.json(publicSession(session!));
  });

  // DELETE /v1/sessions/:id — Terminate session
  registerContractRoute(router, getOpenApiRoute("terminateSession"), async (c) => {
    const id = c.req.param("id")!;
    const tenant = c.get("tenant");

    const existing = await deps.sessionStore.getById(id);
    if (!existing || existing.tenantId !== tenant.tenantId) {
      return c.json({ error: "Session not found" }, 404);
    }

    await deps.sessionStore.terminate(id);
    deps.wakeSession?.(id);
    await deps.sessionRouter?.terminateSession(id);

    return c.json({ type: "session_terminated", id });
  });

  return router;
}
