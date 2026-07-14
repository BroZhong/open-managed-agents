import { Hono } from "hono";
import { listManagedMcpCatalog } from "@oma-server/mcp-catalog";
import type { TenantContext } from "../types.js";

type Env = { Variables: { tenant: TenantContext } };

export function mcpCatalogRoutes() {
  const router = new Hono<Env>();

  router.get("/v1/mcp-catalog", (c) =>
    c.json({
      data: listManagedMcpCatalog({ tenantId: c.get("tenant").tenantId }),
    }),
  );

  return router;
}
