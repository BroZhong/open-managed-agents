import type { TenantContext } from "../types.js";
import { HTTPException } from "hono/http-exception";
import type { ThinkingOptionsReader } from "../lib/thinking-options.js";
import { getOpenApiRoute } from "../openapi/routes.js";
import { createContractRouter, registerContractRoute } from "../openapi/router.js";

/** Agent creation uses the same resolver as Sessions, without creating either. */
export function modelThinkingOptionsRoutes(read?: ThinkingOptionsReader) {
  const router = createContractRouter<{ Variables: { tenant: TenantContext } }>();
  registerContractRoute(router, getOpenApiRoute("getModelThinkingOptions"), async c => {
    c.header("Cache-Control", "private, no-store");
    if (!read) return c.json({ error: "Thinking options unavailable" }, 503);
    try {
      return c.json(await read(c.get("tenant").tenantId, c.req.query("model")!));
    } catch (error) {
      if (error instanceof HTTPException && (error.status === 404 || error.status === 422)) return error.getResponse();
      return c.json({ error: "Could not load model thinking options" }, 503);
    }
  });
  return router;
}
