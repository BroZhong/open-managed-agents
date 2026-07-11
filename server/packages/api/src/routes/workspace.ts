import { Hono } from "hono";
import type { ArtifactStore, Session, SessionStore } from "@oma-server/store";
import type { TurnStreamStore } from "@oma-server/redis";
import type { TenantContext } from "../types.js";

type Env = {
  Variables: {
    tenant: TenantContext;
  };
};

export interface WorkspaceRouteDeps {
  sessionStore: SessionStore;
  artifactStore: ArtifactStore;
  /**
   * Optional — drives the idle write gate (ADR-0006 §3). A write is rejected
   * with 423 while the session's active turn is `running`. When absent (no
   * Redis wired), the gate reads no active turn and every write is allowed.
   */
  turnStreamStore?: TurnStreamStore;
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
 * Join a directory and a filename into a workspace-relative path, tolerating a
 * missing or slash-suffixed directory. An empty dir yields the bare name.
 */
function joinPath(dir: string, name: string): string {
  const d = dir.replace(/\/+$/, "");
  return d ? `${d}/${name}` : name;
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

  /**
   * Idle write gate (ADR-0006 §3). Returns true if the session's active turn is
   * `running`, meaning a checkpoint sync may clobber the write and the caller
   * must reject with 423. `idle`, no active-turn record, or no turnStreamStore
   * wired → false (allow the write). Read active-turn STATUS, not sandbox
   * liveness — a sandbox outlives its turn on its TTL.
   */
  async function isWriteLocked(sessionId: string): Promise<boolean> {
    const turn = await deps.turnStreamStore?.getActiveTurn(sessionId);
    return turn?.status === "running";
  }

  const lockedResponse = { error: "Agent 运行中，稍后可编辑", code: "workspace_locked" } as const;

  // PUT /v1/sessions/:id/workspace/files/content — write (create or overwrite).
  //   body: { path: string, content: string }
  router.put("/v1/sessions/:id/workspace/files/content", async (c) => {
    const tenant = c.get("tenant");
    const session = await resolveSession(c.req.param("id"), tenant);
    if (!session) return c.json({ error: "Session not found" }, 404);

    if (await isWriteLocked(session.id)) return c.json(lockedResponse, 423);

    const body = await c.req.json().catch(() => null);
    const path = body?.path;
    if (typeof path !== "string" || !isSafePath(path)) {
      return c.json({ error: "Invalid file path" }, 400);
    }
    if (typeof body.content !== "string") {
      return c.json({ error: "content is required" }, 400);
    }

    await deps.artifactStore.put({
      tenantId: tenant.tenantId,
      workspaceId: session.workspaceId,
      path,
      body: body.content,
    });
    return c.json({ path });
  });

  // DELETE /v1/sessions/:id/workspace/files/content?path=… — delete one file.
  router.delete("/v1/sessions/:id/workspace/files/content", async (c) => {
    const tenant = c.get("tenant");
    const session = await resolveSession(c.req.param("id"), tenant);
    if (!session) return c.json({ error: "Session not found" }, 404);

    if (await isWriteLocked(session.id)) return c.json(lockedResponse, 423);

    const path = c.req.query("path");
    if (!path || !isSafePath(path)) {
      return c.json({ error: "Invalid file path" }, 400);
    }

    const existed = await deps.artifactStore.delete(
      tenant.tenantId,
      session.workspaceId,
      path,
    );
    if (!existed) return c.json({ error: "File not found" }, 404);
    return c.json({ type: "workspace_file_deleted", path });
  });

  // POST /v1/sessions/:id/workspace/files/rename — rename/move one file.
  //   body: { from: string, to: string }
  //   ArtifactStore has no `move`, so this is get→put→delete, preserving
  //   contentType so a rename never drops the file's MIME.
  router.post("/v1/sessions/:id/workspace/files/rename", async (c) => {
    const tenant = c.get("tenant");
    const session = await resolveSession(c.req.param("id"), tenant);
    if (!session) return c.json({ error: "Session not found" }, 404);

    if (await isWriteLocked(session.id)) return c.json(lockedResponse, 423);

    const body = await c.req.json().catch(() => null);
    const from = body?.from;
    const to = body?.to;
    if (
      typeof from !== "string" ||
      typeof to !== "string" ||
      !isSafePath(from) ||
      !isSafePath(to)
    ) {
      return c.json({ error: "Invalid file path" }, 400);
    }

    const src = await deps.artifactStore.get(
      tenant.tenantId,
      session.workspaceId,
      from,
    );
    if (!src) return c.json({ error: "File not found" }, 404);

    await deps.artifactStore.put({
      tenantId: tenant.tenantId,
      workspaceId: session.workspaceId,
      path: to,
      body: src.body,
      contentType: src.contentType,
    });
    await deps.artifactStore.delete(tenant.tenantId, session.workspaceId, from);
    return c.json({ type: "workspace_file_renamed", from, to });
  });

  // POST /v1/sessions/:id/workspace/files/upload — multipart upload (incl. media).
  //   multipart/form-data: file field(s) + a target path. Per-file `path`, or a
  //   `destDir` combined with the uploaded filename. Writes are proxied through
  //   the Host (never presigned PUT — ADR-0006 §2). Media contentType is taken
  //   from the upload so a later signed GET returns the right MIME.
  router.post("/v1/sessions/:id/workspace/files/upload", async (c) => {
    const tenant = c.get("tenant");
    const session = await resolveSession(c.req.param("id"), tenant);
    if (!session) return c.json({ error: "Session not found" }, 404);

    if (await isWriteLocked(session.id)) return c.json(lockedResponse, 423);

    const form = await c.req.parseBody({ all: true }).catch(() => null);
    if (!form) return c.json({ error: "Invalid multipart body" }, 400);

    const destDirRaw = form.destDir;
    const destDir = typeof destDirRaw === "string" ? destDirRaw : "";
    const explicitPath = typeof form.path === "string" ? form.path : undefined;

    // Collect all File-valued form entries (a field may hold one or many).
    const files: File[] = [];
    for (const value of Object.values(form)) {
      for (const v of Array.isArray(value) ? value : [value]) {
        if (v instanceof File) files.push(v);
      }
    }
    if (files.length === 0) {
      return c.json({ error: "No files in upload" }, 400);
    }

    const written: Array<{ path: string }> = [];
    for (const file of files) {
      // Single-file uploads may name the target with `path`; otherwise place
      // the file under `destDir` using its own filename.
      const target =
        files.length === 1 && explicitPath
          ? explicitPath
          : joinPath(destDir, file.name);
      if (!isSafePath(target)) {
        return c.json({ error: "Invalid file path" }, 400);
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      await deps.artifactStore.put({
        tenantId: tenant.tenantId,
        workspaceId: session.workspaceId,
        path: target,
        body: bytes,
        contentType: file.type || undefined,
      });
      written.push({ path: target });
    }
    return c.json({ data: written });
  });

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
