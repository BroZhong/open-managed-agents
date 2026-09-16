import { expect, it } from "vitest";
import { resolveResourcePath } from "./resource-path";
const skills = [{ id: "private-fork", name: "research", description: "", sourceSkillId: "library-id", createdAt: null, updatedAt: "2026-09-16" }];
it.each(["file:///skills/research/", "/skills/research", "/skills/research/", "/skills/research/SKILL.md", "skills/research/references/guide.md", "/skills/private-fork/SKILL.md"])("resolves %s to the Agent's private copy", (path) => {
  expect(resolveResourcePath(path, skills)).toEqual({ kind: "skill", skillId: "private-fork" });
});
it("does not send a missing Skill to Workspace storage", () => {
  expect(resolveResourcePath("/skills/missing", skills)).toEqual({ kind: "unavailable-skill" });
});
it.each(["https://example.com/skills/research", "//example.com/file", "mailto:user@example.com", "/etc/passwd", "../../secret", "%2e%2e/secret", "#heading", "%zz"])("does not intercept %s", (path) => {
  expect(resolveResourcePath(path, skills)).toBeNull();
});
it.each([
  ["/home/user/workspace/novels/73995/chapters", "novels/73995/chapters"],
  ["./novels/73995/chapters/", "novels/73995/chapters/"],
  ["notes/a%20b.md#section", "notes/a b.md"],
  ["/home/user/workspace/skills/research.txt", "skills/research.txt"],
  ["/home/user/workspace", ""],
  ["file:///home/user/workspace/novels/73995/chapters/", "novels/73995/chapters/"],
])("normalizes Workspace link %s", (path, expected) => {
  expect(resolveResourcePath(path, skills)).toEqual({ kind: "workspace", path: expected });
});
