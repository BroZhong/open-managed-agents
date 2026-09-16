import type { EquippedSkill } from "@/lib/hooks/use-skills";

export type ResourcePath =
  | { kind: "skill"; skillId: string }
  | { kind: "unavailable-skill" }
  | { kind: "workspace"; path: string };

/** Resolve sandbox paths, never arbitrary URLs or paths outside the Workspace. */
export function resolveResourcePath(href: string, skills: EquippedSkill[]): ResourcePath | null {
  if (href.startsWith("file:///")) href = href.slice("file://".length);
  if (!href || href.startsWith("#") || href.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(href)) return null;
  let path: string;
  try { path = decodeURIComponent(href.split(/[?#]/)[0]); } catch { return null; }
  if (/[\0\\]/.test(path)) return null;
  if (/^\/?skills(?:\/|$)/.test(path)) {
    const name = path.replace(/^\/?skills\/?/, "").split("/")[0];
    const skill = skills.find((candidate) => candidate.name === name || candidate.id === name);
    return skill ? { kind: "skill", skillId: skill.id } : { kind: "unavailable-skill" };
  }
  if (path === "/home/user/workspace") path = "";
  else if (path.startsWith("/home/user/workspace/")) path = path.slice("/home/user/workspace/".length);
  else if (path.startsWith("/")) return null;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return { kind: "workspace", path: parts.join("/") + (path.endsWith("/") && parts.length ? "/" : "") };
}
