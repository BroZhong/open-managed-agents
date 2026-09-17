import type { SessionShareStore, SessionStore, WorkspaceMetadataStore } from "@oma-server/store";
import { createMiddleware } from "hono/factory";
import type { ApiKeyStore, TenantContext } from "../types.js";
import { createHash } from "node:crypto";
import { verifySessionToken } from "../auth/tokens.js";

type Env = {
  Variables: {
    tenant: TenantContext;
  };
};

interface ShareAccessDeps {
  sessionShareStore?: SessionShareStore;
  sessionStore?: SessionStore;
  workspaceStore?: WorkspaceMetadataStore;
}

export function authMiddleware(apiKeyStore: ApiKeyStore, deps: ShareAccessDeps = {}, basePath = "") {
  return createMiddleware<Env>(async (c, next) => {
    // A share header always narrows authority, including with owner credentials
    // or AUTH_DISABLED. Unknown operations and resources fail closed.
    const shareId = c.req.header("x-session-share");
    if (shareId !== undefined) {
      c.header("Cache-Control", "no-store");
      c.header("Referrer-Policy", "no-referrer");
      const share = /^[A-Za-z0-9_-]{43}$/.test(shareId)
        ? await deps.sessionShareStore?.getById(shareId) : null;
      const session = share && await deps.sessionStore?.getById(share.sessionId);
      const workspace = session && await deps.workspaceStore?.getById(session.tenantId, session.workspaceId);
      if (!session || session.deletedAt || !workspace || workspace.deletedAt) {
        return c.json({ error: "Share unavailable", code: "share_unavailable" }, 404);
      }
      const path = c.req.path.slice(basePath.length);
      const sessionPath = `/v1/sessions/${encodeURIComponent(session.id)}`;
      const filesPath = `/v1/workspaces/${encodeURIComponent(workspace.id)}/files`;
      const allowed = c.req.method === "GET" && (
        path === `/v1/shares/${shareId}` || path === sessionPath ||
        path === `${sessionPath}/events` || path === filesPath || path.startsWith(`${filesPath}/`)
      ) && !(c.req.header("accept") ?? "").toLowerCase().includes("text/event-stream");
      if (!allowed) return c.json({ error: "Share access denied" }, 403);
      c.set("tenant", { tenantId: session.tenantId, share: { id: shareId, sessionId: session.id, workspaceId: workspace.id } });
      return next();
    }

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
