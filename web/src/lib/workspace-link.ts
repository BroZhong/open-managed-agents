const WORKSPACE_ROOT = "/home/user/workspace/";

/** Resolve file links against the Session's Workspace, never against the web route. */
export function workspaceLinkPath(href: string): string | null {
  let path = href.split(/[?#]/, 1)[0];
  try { path = decodeURIComponent(path); } catch { return null; }
  if (path.startsWith("file://")) path = path.slice(7);
  if (path.startsWith(WORKSPACE_ROOT)) path = path.slice(WORKSPACE_ROOT.length);
  else if (path.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(path)) return null;
  if (!path || /[\0\\]/.test(path)) return null;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else if (part && part !== ".") parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}
