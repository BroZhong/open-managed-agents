import { createMiddleware } from "hono/factory";
import type { ApiKeyStore, TenantContext } from "../types.js";
import { createHash } from "node:crypto";

type Env = {
  Variables: {
    tenant: TenantContext;
  };
};

export function authMiddleware(apiKeyStore: ApiKeyStore) {
  return createMiddleware<Env>(async (c, next) => {
    if (process.env.AUTH_DISABLED === "true") {
      c.set("tenant", { tenantId: "dev" });
      return next();
    }

    const apiKey = c.req.header("x-api-key");
    if (!apiKey) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const keyHash = createHash("sha256").update(apiKey).digest("hex");
    const tenant = await apiKeyStore.findByKeyHash(keyHash);

    if (!tenant) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    c.set("tenant", tenant);
    return next();
  });
}
