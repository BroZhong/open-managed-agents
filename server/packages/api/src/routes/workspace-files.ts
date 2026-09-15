import type { OpenAPIHono } from "@hono/zod-openapi";
import type { ArtifactStore, Workspace, WorkspaceMetadataStore } from "@oma-server/store";
import { validateArtifactPath, resolveArtifactContentType } from "@oma-server/store";
import type { TenantContext } from "../types.js";
import { getOpenApiRoute } from "../openapi/routes.js";
import {
  createContractRouter,
  registerContractRoute,
} from "../openapi/router.js";

type Env = {
  Variables: {
    tenant: TenantContext;
  };
};

export interface WorkspaceFileRouteDeps {
  workspaceStore: WorkspaceMetadataStore;
  artifactStore: ArtifactStore;
}

/**
 * Reject workspace-relative paths that try to escape their tenant/workspace
 * prefix. The ArtifactStore also normalizes, but we fail fast here so a bad
 * request never reaches OSS. Paths have been decoded once by the HTTP layer;
 * the shared validator never decodes literal percent signs again.
 */
function isSafePath(path: string): boolean {
  try {
    validateArtifactPath(path);
    return true;
  } catch {
    return false;
  }
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
 * Host proxy over a Tenant-owned Workspace Store. OSS is the source of truth,
 * so files created by any means (including shell/bash) show up in the listing.
 * Contents are proxied through the Host, with short-lived signed GET for media.
 */
export function workspaceFileRoutes(deps: WorkspaceFileRouteDeps): OpenAPIHono<Env> {
  const router = createContractRouter<Env>();

  // Do not turn a failed list into an empty Workspace or expose storage SDK
  // errors (which can contain signed requests or credentials) to the browser.
  router.onError((_error, c) => c.json({
    error: "Workspace storage is unavailable. Retry the file operation.",
    code: "workspace_storage_error",
  }, 503));

  async function resolveWorkspace(
    workspaceId: string,
    tenant: TenantContext,
  ): Promise<Workspace | null> {
    return deps.workspaceStore.getById(tenant.tenantId, workspaceId);
  }

  // PUT /v1/workspaces/:id/files/content — write (create or overwrite).
  //   body: { path: string, content: string }
  registerContractRoute(router, getOpenApiRoute("writeWorkspaceFile"), async (c) => {
    const tenant = c.get("tenant");
    const workspace = await resolveWorkspace(c.req.param("id")!, tenant);
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);

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
      workspaceId: workspace.id,
      path,
      body: body.content,
    });
    return c.json({ path });
  });

  // DELETE /v1/workspaces/:id/files/content?path=… — delete one file.
  registerContractRoute(router, getOpenApiRoute("deleteWorkspaceFile"), async (c) => {
    const tenant = c.get("tenant");
    const workspace = await resolveWorkspace(c.req.param("id")!, tenant);
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);

    const path = c.req.query("path");
    if (!path || !isSafePath(path)) {
      return c.json({ error: "Invalid file path" }, 400);
    }

    const existed = await deps.artifactStore.delete(
      tenant.tenantId,
      workspace.id,
      path,
    );
    if (!existed) return c.json({ error: "File not found" }, 404);
    return c.json({ type: "workspace_file_deleted", path });
  });

  // POST /v1/workspaces/:id/files/rename — rename/move one file.
  //   body: { from: string, to: string }
  //   ArtifactStore has no `move`, so this is get→put→delete, preserving
  //   contentType so a rename never drops the file's MIME.
  registerContractRoute(router, getOpenApiRoute("renameWorkspaceFile"), async (c) => {
    const tenant = c.get("tenant");
    const workspace = await resolveWorkspace(c.req.param("id")!, tenant);
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);

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
      workspace.id,
      from,
    );
    if (!src) return c.json({ error: "File not found" }, 404);
    if (from === to) return c.json({ type: "workspace_file_renamed", from, to });

    await deps.artifactStore.put({
      tenantId: tenant.tenantId,
      workspaceId: workspace.id,
      path: to,
      body: src.body,
      contentType: src.contentType,
    });
    await deps.artifactStore.delete(tenant.tenantId, workspace.id, from);
    return c.json({ type: "workspace_file_renamed", from, to });
  });

  // POST /v1/workspaces/:id/files/upload — multipart upload (incl. media).
  //   multipart/form-data: file field(s) + a target path. Per-file `path`, or a
  //   `destDir` combined with the uploaded filename. Writes are proxied through
  //   the Host (never presigned PUT — ADR-0006 §2). Media contentType is taken
  //   from the upload so a later signed GET returns the right MIME.
  registerContractRoute(router, getOpenApiRoute("uploadWorkspaceFiles"), async (c) => {
    const tenant = c.get("tenant");
    const workspace = await resolveWorkspace(c.req.param("id")!, tenant);
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);

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
        workspaceId: workspace.id,
        path: target,
        body: bytes,
        contentType: file.type || undefined,
      });
      written.push({ path: target });
    }
    return c.json({ data: written });
  });

  // GET /v1/workspaces/:id/preview-url?path=…&expiresIn=… — sign a
  // short-lived, read-only GET URL for a media file (ADR-0006 §1). The path is a
  // query param (not a route segment) so it never collides with the `files/*`
  // wildcard, which would otherwise swallow `files/<x>/preview-url`. Only signs
  // GET — writes are never presigned (ADR-0006 §2). The file must exist first, so
  // we never sign a URL for an absent key (avoids leaking existence).
  const MIN_EXPIRES = 60;
  const MAX_EXPIRES = 900;
  const DEFAULT_EXPIRES = 600;
  registerContractRoute(router, getOpenApiRoute("createWorkspacePreviewUrl"), async (c) => {
    const tenant = c.get("tenant");
    const workspace = await resolveWorkspace(c.req.param("id")!, tenant);
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);

    const path = c.req.query("path");
    if (!path || !isSafePath(path)) {
      return c.json({ error: "Invalid file path" }, 400);
    }

    const exists = await deps.artifactStore.exists(
      tenant.tenantId,
      workspace.id,
      path,
    );
    if (!exists) return c.json({ error: "File not found" }, 404);

    if (!deps.artifactStore.createSignedReadUrl) {
      return c.json(
        { error: "Presigned reads not supported by this backend" },
        501,
      );
    }

    const raw = Number(c.req.query("expiresIn"));
    const expiresIn = Number.isFinite(raw)
      ? Math.min(MAX_EXPIRES, Math.max(MIN_EXPIRES, Math.trunc(raw)))
      : DEFAULT_EXPIRES;

    const url = await deps.artifactStore.createSignedReadUrl(
      tenant.tenantId,
      workspace.id,
      path,
      expiresIn,
    );
    return c.json({ url, expiresIn });
  });

  // GET /v1/workspaces/:id/files — list the Workspace file tree.
  registerContractRoute(router, getOpenApiRoute("listWorkspaceFiles"), async (c) => {
    const tenant = c.get("tenant");
    const workspace = await resolveWorkspace(c.req.param("id")!, tenant);
    if (!workspace) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    const prefix = c.req.query("prefix")?.replace(/\/$/, "") || undefined;
    if (prefix !== undefined && !isSafePath(prefix)) {
      return c.json({ error: "Invalid prefix" }, 400);
    }

    const artifacts = await deps.artifactStore.list(
      tenant.tenantId,
      workspace.id,
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

  // GET /v1/workspaces/:id/files/* — preview / download a single file.
  // `?download=1` sets Content-Disposition: attachment.
  registerContractRoute(router, getOpenApiRoute("getWorkspaceFile"), async (c) => {
    const tenant = c.get("tenant");
    const workspace = await resolveWorkspace(c.req.param("id")!, tenant);
    if (!workspace) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    // Extract after the resolved Workspace path, including when its ID is "files".
    const fullPath = c.req.path;
    const marker = `/workspaces/${encodeURIComponent(workspace.id)}/files/`;
    const idx = fullPath.indexOf(marker);
    const raw = idx >= 0 ? fullPath.slice(idx + marker.length) : "";
    let path: string;
    try {
      path = decodeURIComponent(raw);
    } catch {
      return c.json({ error: "Invalid file path encoding" }, 400);
    }

    if (!path || !isSafePath(path)) {
      return c.json({ error: "Invalid file path" }, 400);
    }

    const artifact = await deps.artifactStore.get(
      tenant.tenantId,
      workspace.id,
      path,
    );
    if (!artifact) {
      return c.json({ error: "File not found" }, 404);
    }

    const download = c.req.query("download") === "1";
    const contentType = resolveArtifactContentType(path, artifact.contentType);
    const headers: Record<string, string> = {
      "content-type": contentType,
      "content-length": String(artifact.body.byteLength),
      "cache-control": "no-store",
    };
    if (download) {
      // Strip quotes AND CR/LF so a crafted filename can't break out of the
      // header value or inject a new header (defense-in-depth; path is already
      // isSafePath-checked).
      const filename = basename(path);
      const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
      const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (char) =>
        `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
      );
      headers["content-disposition"] = `attachment; filename="${fallback}"` +
        (fallback !== filename ? `; filename*=UTF-8''${encoded}` : "");
    } else {
      headers["content-disposition"] = "inline";
    }

    return c.body(artifact.body as unknown as ArrayBuffer, 200, headers);
  }, { runtimePath: "/v1/workspaces/:id/files/:path{.+}" });

  return router;
}
