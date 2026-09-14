/**
 * Trusted key contract shared by the Host and the Sandbox mount:
 * `<tenantId>/<workspaceId>/`. IDs are opaque, unencoded ASCII segments.
 * Callers must resolve Workspace ownership before constructing the prefix.
 * Mount subPath is this value without the final slash; object operations retain
 * the slash so adjacent Workspace IDs can never share a listing boundary.
 */
export function workspaceObjectPrefix(tenantId: string, workspaceId: string): string {
  for (const id of [tenantId, workspaceId]) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw new Error("Invalid Workspace storage identity");
    }
  }
  return `${tenantId}/${workspaceId}/`;
}

/**
 * A literal, decoded-once POSIX relative file path. Do not URI-decode here:
 * a name containing `%2f` is distinct from a directory separator. The OSS SDK
 * performs the wire encoding; normalizing paths here would introduce aliases.
 */
export function validateArtifactPath(path: string): string {
  if (!path || /[\\\u0000-\u001f\u007f]/.test(path) || path.split("/").some((part) => !part || part === "." || part === "..") || path.split("/")[0] === ".oma-workspace-checks") {
    throw new Error("Invalid artifact path");
  }
  try { encodeURIComponent(path); } catch { throw new Error("Invalid artifact path"); }
  return path;
}
