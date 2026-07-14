import { Hono } from "hono";
import type { AgentStore, SessionStore, WorkspaceMetadataStore } from "@oma-server/store";
import type { SessionRouter } from "@oma-server/session-router";
import type { TenantContext } from "../types.js";
import { publicSession } from "../lib/public-projection.js";

type Env = {
  Variables: {
    tenant: TenantContext;
  };
};

export interface SessionRouteDeps {
  sessionStore: SessionStore;
  agentStore: AgentStore;
  workspaceStore: WorkspaceMetadataStore;
  sessionRouter?: SessionRouter;
}

export function sessionRoutes(deps: SessionRouteDeps) {
  const router = new Hono<Env>();

  // POST /v1/sessions — Create session
  router.post("/v1/sessions", async (c) => {
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

    const session = await deps.sessionStore.create({
      tenantId: tenant.tenantId,
      agentId: agent.id,
      agent,
      workspaceId: workspace.id,
    });

    return c.json(publicSession(session), 201);
  });

  // GET /v1/sessions — List sessions
  router.get("/v1/sessions", async (c) => {
    const tenant = c.get("tenant");
    const limitParam = c.req.query("limit");
    const cursor = c.req.query("cursor") || undefined;
    const agentId = c.req.query("agent_id") || undefined;
    const status = c.req.query("status") || undefined;
    const loopId = c.req.query("loop_id") || undefined;
    const excludeLoop = c.req.query("exclude_loop");
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

    const result = await deps.sessionStore.list(tenant.tenantId, {
      limit,
      cursor,
      agentId,
      status: status as any,
      loopId,
      withoutLoop: excludeLoop === "true",
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

  // GET /v1/sessions/:id — Get session
  router.get("/v1/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const tenant = c.get("tenant");

    const session = await deps.sessionStore.getById(id);
    if (!session || session.tenantId !== tenant.tenantId) {
      return c.json({ error: "Session not found" }, 404);
    }

    return c.json(publicSession(session));
  });

  // DELETE /v1/sessions/:id — Terminate session
  router.delete("/v1/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const tenant = c.get("tenant");

    const existing = await deps.sessionStore.getById(id);
    if (!existing || existing.tenantId !== tenant.tenantId) {
      return c.json({ error: "Session not found" }, 404);
    }

    await deps.sessionStore.terminate(id);
    await deps.sessionRouter?.terminateSession(id);

    return c.json({ type: "session_terminated", id });
  });

  return router;
}
