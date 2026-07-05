import { describe, it, expect } from "vitest";
import { detectSkills, parseSkillMetadata } from "../src/skills/detect-skills.js";

const SKILL_MD = `---
name: greeter
description: Greets warmly
---
# Greeter
Say hello.`;

describe("detectSkills", () => {
  it("single folder with root SKILL.md → one Skill (whole ROOT)", () => {
    const r = detectSkills([
      { path: "SKILL.md", content: SKILL_MD },
      { path: "extra.md", content: "notes" },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skills).toHaveLength(1);
    expect(r.skills[0].name).toBe("greeter");
    expect(r.skills[0].description).toBe("Greets warmly");
    // Files keep their ROOT-relative paths (SKILL.md at top).
    expect(r.skills[0].files.map((f) => f.path).sort()).toEqual(["SKILL.md", "extra.md"].sort());
  });

  it("multiple child folders each with SKILL.md → N Skills", () => {
    const r = detectSkills([
      { path: "a/SKILL.md", content: "---\nname: a\ndescription: da\n---" },
      { path: "a/x.md", content: "x" },
      { path: "b/SKILL.md", content: "---\nname: b\ndescription: db\n---" },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skills.map((s) => s.name).sort()).toEqual(["a", "b"]);
    const a = r.skills.find((s) => s.name === "a")!;
    // Child files are re-rooted to the Skill dir (SKILL.md at top).
    expect(a.files.map((f) => f.path).sort()).toEqual(["SKILL.md", "x.md"].sort());
  });

  it("no SKILL.md anywhere → reject", () => {
    const r = detectSkills([{ path: "readme.md", content: "hi" }]);
    expect(r.ok).toBe(false);
  });

  it("ambiguous mix (root + child SKILL.md) → reject", () => {
    const r = detectSkills([
      { path: "SKILL.md", content: SKILL_MD },
      { path: "child/SKILL.md", content: "---\nname: c\ndescription: dc\n---" },
    ]);
    expect(r.ok).toBe(false);
  });
});

describe("parseSkillMetadata", () => {
  it("reads name/description from frontmatter", () => {
    const m = parseSkillMetadata(SKILL_MD, "fallback");
    expect(m.name).toBe("greeter");
    expect(m.description).toBe("Greets warmly");
  });

  it("falls back to given name and first body line when frontmatter absent", () => {
    const m = parseSkillMetadata("# Title\nA helpful skill.", "dirname");
    expect(m.name).toBe("dirname");
    expect(m.description).toBe("A helpful skill.");
  });
});
