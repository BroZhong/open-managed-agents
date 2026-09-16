import { expect, it } from "vitest";
import { workspaceLinkPath } from "./workspace-link";

it.each([
  ["/home/user/workspace/novel/narration.txt", "novel/narration.txt"],
  ["file:///home/user/workspace/novel/a%20b.txt", "novel/a b.txt"],
  ["./novel/../notes.md#L3", "notes.md"],
  ["novel/production.json", "novel/production.json"],
  ["https://example.com/notes.md", null],
  ["//example.com/notes.md", null],
  ["/skills/story/SKILL.md", null],
  ["/home/user/workspace/../secret", null],
  ["../secret", null],
  ["%2e%2e/secret", null],
  ["#heading", null],
  ["javascript:alert(1)", null],
  ["bad%zz", null],
])("resolves %s to %s", (href, expected) => {
  expect(workspaceLinkPath(href)).toBe(expected);
});
