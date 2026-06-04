import { Hono } from "hono";
import type { ApiKeyStore } from "@oma-server/store";
import type { TenantContext } from "../types.js";

type Env = {
  Variables: {
    tenant: TenantContext;
  };
};

export function apiKeyRoutes(apiKeyStore: ApiKeyStore) {
  const router = new Hono<Env>();

  // GET /v1/api-keys — List keys for the tenant
  router.get("/v1/api-keys", async (c) => {
    const tenant = c.get("tenant");
    const keys = await apiKeyStore.list(tenant.tenantId);

    const data = keys.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      createdAt: k.createdAt,
    }));

    return c.json({ data, has_more: false });
  });

  // POST /v1/api-keys — Create a key
  router.post("/v1/api-keys", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { name } = body;
    if (!name || typeof name !== "string") {
      return c.json({ error: "name is required" }, 400);
    }

    const tenant = c.get("tenant");
    const result = await apiKeyStore.create(tenant.tenantId, name);

    return c.json(
      {
        id: result.apiKey.id,
        name: result.apiKey.name,
        key: result.rawKey,
        prefix: result.apiKey.prefix,
        createdAt: result.apiKey.createdAt,
      },
      201,
    );
  });

  // DELETE /v1/api-keys/:id — Delete a key
  router.delete("/v1/api-keys/:id", async (c) => {
    const id = c.req.param("id");
    const deleted = await apiKeyStore.delete(id);

    if (!deleted) {
      return c.json({ error: "Not found" }, 404);
    }

    return c.json({ type: "api_key_deleted", id });
  });

  return router;
}
