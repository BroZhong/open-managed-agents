import type { OpenAPIHono } from "@hono/zod-openapi";
import { listManagedMcpCatalog } from "@oma-server/mcp-catalog";
import type { TenantContext } from "../types.js";
import { getOpenApiRoute } from "../openapi/routes.js";
import {
  createContractRouter,
  registerContractRoute,
} from "../openapi/router.js";

type Env = { Variables: { tenant: TenantContext } };

export function mcpCatalogRoutes(): OpenAPIHono<Env> {
  const router = createContractRouter<Env>();

  registerContractRoute(router, getOpenApiRoute("listManagedMcpCatalog"), (c) =>
    c.json({
      data: listManagedMcpCatalog({ tenantId: c.get("tenant").tenantId }),
    }),
  );

  return router;
}
