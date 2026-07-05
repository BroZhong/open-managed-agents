import { createMiddleware } from "hono/factory";
import type { ApiKeyStore, TenantContext } from "../types.js";
import { createHash } from "node:crypto";
import { verifySessionToken } from "../auth/tokens.js";

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

    // Session token (browser console): Authorization: Bearer <jwt>. Verified
    // with AUTH_JWT_SECRET (HS256). Takes precedence over x-api-key; an invalid
    // Bearer is a hard 401 (we do not fall through to the api-key path).
    const authHeader = c.req.header("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice("Bearer ".length).trim();
      const session = await verifySessionToken(token);
      if (!session) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      c.set("tenant", { tenantId: session.tenantId });
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
