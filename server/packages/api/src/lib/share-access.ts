/** Closed operation allowlist. Resource scope is enforced by auth middleware. */
export const SHARE_READ_OPERATIONS = new Set([
  "resolveSessionShare", "getSession", "listSessionEvents", "listWorkspaceFiles", "getWorkspaceFile",
]);
