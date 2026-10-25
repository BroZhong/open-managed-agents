import type { OpenAPIHono } from "@hono/zod-openapi";
import type { TenantContext } from "../types.js";
import type { EnvironmentService } from "../lib/environments.js";
import { CreateEnvironmentInputSchema, UpdateEnvironmentInputSchema } from "../openapi/environments.js";
import { getOpenApiRoute } from "../openapi/routes.js";
import { createContractRouter, registerContractRoute } from "../openapi/router.js";

type Env = { Variables: { tenant: TenantContext } };

/**
 * Environments (ADR-0024): list, get, create (or copy with `from`), update
 * with `POST /{id}`, and soft delete. Building is the image builder's.
 */
export function environmentRoutes(service: EnvironmentService): OpenAPIHono<Env> {
  const router = createContractRouter<Env>();
  const tenantId = (c: { get(key: "tenant"): TenantContext }) => c.get("tenant").tenantId;

  registerContractRoute(router, getOpenApiRoute("listEnvironments"), async (c) =>
    c.json({ data: await service.list(tenantId(c)) }));

  registerContractRoute(router, getOpenApiRoute("getEnvironment"), async (c) =>
    c.json(await service.get(tenantId(c), c.req.param("id")!)));

  registerContractRoute(router, getOpenApiRoute("createEnvironment"), async (c) =>
    c.json(await service.create(tenantId(c), CreateEnvironmentInputSchema.parse(await c.req.json())), 201));

  registerContractRoute(router, getOpenApiRoute("updateEnvironment"), async (c) =>
    c.json(await service.update(tenantId(c), c.req.param("id")!, UpdateEnvironmentInputSchema.parse(await c.req.json()))));

  registerContractRoute(router, getOpenApiRoute("deleteEnvironment"), async (c) =>
    c.json(await service.delete(tenantId(c), c.req.param("id")!)));

  return router;
}
