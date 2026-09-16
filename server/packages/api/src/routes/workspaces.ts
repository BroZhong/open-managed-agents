import type { OpenAPIHono } from "@hono/zod-openapi";
import type { WorkspaceMetadataStore } from "@oma-server/store";
import { workspaceObjectPrefix } from "@oma-server/store";
import type { TenantContext } from "../types.js";
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

/**
 * Workspace entity routes (create-named + list + get). Distinct from the
 * Workspace *file proxy* routes in `workspace-files.ts`, which list/preview a
 * Workspace's files. Here a Workspace is a first-class, nameable, tenant-owned
 * file collection that a Session can mount at creation.
 */
export function workspaceEntityRoutes(
  workspaceStore: WorkspaceMetadataStore,
): OpenAPIHono<Env> {
  const router = createContractRouter<Env>();

  // POST /v1/workspaces — Create (or idempotently return) a Workspace.
  registerContractRoute(router, getOpenApiRoute("createWorkspace"), async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const id = body.id ?? body.workspaceId;
    if (id !== undefined && typeof id !== "string") {
      return c.json({ error: "id must be a string" }, 400);
    }
    const name = body.name;
    if (name !== undefined && typeof name !== "string") {
      return c.json({ error: "name must be a string" }, 400);
    }

    const tenant = c.get("tenant");
    if (id !== undefined) {
      try {
        workspaceObjectPrefix(tenant.tenantId, id);
      } catch {
        return c.json({ error: "Workspace id must contain 1–128 letters, numbers, underscores or hyphens" }, 400);
      }
    }
    const workspace = await workspaceStore.create({
      tenantId: tenant.tenantId,
      id,
      name,
    });

    if (workspace.deletedAt) return c.json({ error: "Workspace has been deleted" }, 409);
    return c.json(workspace, 201);
  });

  // GET /v1/workspaces — List the tenant's Workspaces (ordered by created_at).
  registerContractRoute(router, getOpenApiRoute("listWorkspaces"), async (c) => {
    const tenant = c.get("tenant");
    const data = await workspaceStore.list(tenant.tenantId);
    return c.json({ data });
  });

  // GET /v1/workspaces/:id — Get one; 404 on not-found or cross-tenant.
  registerContractRoute(router, getOpenApiRoute("getWorkspace"), async (c) => {
    const id = c.req.param("id")!;
    const tenant = c.get("tenant");
    const workspace = await workspaceStore.getById(tenant.tenantId, id);
    if (!workspace || workspace.deletedAt) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.json(workspace);
  });

  // POST /v1/workspaces/:id — Update a Workspace (currently just rename).
  registerContractRoute(router, getOpenApiRoute("updateWorkspace"), async (c) => {
    const id = c.req.param("id")!;
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (body.name !== undefined && typeof body.name !== "string") {
      return c.json({ error: "name must be a string" }, 400);
    }

    const tenant = c.get("tenant");
    const existing = await workspaceStore.getById(tenant.tenantId, id);
    if (!existing || existing.deletedAt) return c.json({ error: "Not found" }, 404);
    const updated = await workspaceStore.update(tenant.tenantId, id, {
      name: body.name,
    });
    if (!updated) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.json(updated);
  });

  registerContractRoute(router, getOpenApiRoute("deleteWorkspace"), async (c) => {
    const tenant = c.get("tenant");
    const id = c.req.param("id")!;
    const workspace = await workspaceStore.softDelete(tenant.tenantId, id);
    if (!workspace) return c.json({ error: "Not found" }, 404);
    return c.json({ type: "workspace_deleted", id });
  });

  return router;
}
