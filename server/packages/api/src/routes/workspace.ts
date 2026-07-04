import { Hono } from "hono";
import type { ArtifactStore, Session, SessionStore } from "@oma-server/store";
import type { TenantContext } from "../types.js";

type Env = {
  Variables: {
    tenant: TenantContext;
  };
};

export interface WorkspaceRouteDeps {
  sessionStore: SessionStore;
  artifactStore: ArtifactStore;
}

/**
 * Reject workspace-relative paths that try to escape their tenant/workspace
 * prefix. The ArtifactStore also normalizes, but we fail fast here so a bad
 * request never reaches the S3 backend.
 */
function isSafePath(path: string): boolean {
  if (!path) return false;
  const segments = path.split("/");
  return !segments.some((s) => s === "." || s === "..");
}

/**
 * Derive a human filename (last path segment) for Content-Disposition.
 */
function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/**
 * Host proxy over the session's Workspace S3 store. S3 is the source of truth,
 * so files created by any means (including shell/bash) show up in the listing.
 * Contents are proxied through the Host — never presigned URLs. See ADR-0002 §5.
 */
export function workspaceRoutes(deps: WorkspaceRouteDeps) {
  const router = new Hono<Env>();

  async function resolveSession(
    sessionId: string,
    tenant: TenantContext,
  ): Promise<Session | null> {
    const session = await deps.sessionStore.getById(sessionId);
    if (!session || session.tenantId !== tenant.tenantId) return null;
    return session;
  }

  // GET /v1/sessions/:id/workspace/files — list the Workspace file tree.
  router.get("/v1/sessions/:id/workspace/files", async (c) => {
    const tenant = c.get("tenant");
    const session = await resolveSession(c.req.param("id"), tenant);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    const prefix = c.req.query("prefix") || undefined;
    if (prefix !== undefined && !isSafePath(prefix)) {
      return c.json({ error: "Invalid prefix" }, 400);
    }

    const artifacts = await deps.artifactStore.list(
      tenant.tenantId,
      session.workspaceId,
      prefix,
    );

    return c.json({
      data: artifacts.map((a) => ({
        path: a.path,
        size: a.size,
        updated_at: a.updatedAt ? a.updatedAt.toISOString() : null,
      })),
    });
  });

  // GET /v1/sessions/:id/workspace/files/* — preview / download a single file.
  // `?download=1` sets Content-Disposition: attachment.
  router.get("/v1/sessions/:id/workspace/files/*", async (c) => {
    const tenant = c.get("tenant");
    const session = await resolveSession(c.req.param("id"), tenant);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    // Everything after `/workspace/files/` is the workspace-relative path.
    const fullPath = c.req.path;
    const marker = "/workspace/files/";
    const idx = fullPath.indexOf(marker);
    const raw = idx >= 0 ? fullPath.slice(idx + marker.length) : "";
    const path = decodeURIComponent(raw);

    if (!path || !isSafePath(path)) {
      return c.json({ error: "Invalid file path" }, 400);
    }

    const artifact = await deps.artifactStore.get(
      tenant.tenantId,
      session.workspaceId,
      path,
    );
    if (!artifact) {
      return c.json({ error: "File not found" }, 404);
    }

    const download = c.req.query("download") === "1";
    const contentType = artifact.contentType ?? "application/octet-stream";
    const headers: Record<string, string> = {
      "content-type": contentType,
      "content-length": String(artifact.body.byteLength),
      "cache-control": "no-store",
    };
    if (download) {
      headers["content-disposition"] =
        `attachment; filename="${basename(path).replace(/"/g, "")}"`;
    } else {
      headers["content-disposition"] = "inline";
    }

    return c.body(artifact.body as unknown as ArrayBuffer, 200, headers);
  });

  return router;
}
