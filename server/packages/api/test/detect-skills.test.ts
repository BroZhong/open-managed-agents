import { describe, it, expect } from "vitest";
import { detectSkills, parseSkillMetadata } from "../src/skills/detect-skills.js";

const SKILL_MD = `---
name: greeter
description: Greets warmly
---
# Greeter
Say hello.`;

const bytes = (text: string) => new TextEncoder().encode(text);

describe("detectSkills", () => {
  it("single folder with root SKILL.md → one Skill (whole ROOT)", () => {
    const r = detectSkills([
      { path: "SKILL.md", body: bytes(SKILL_MD) },
      { path: "extra.md", body: bytes("notes") },
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
      { path: "a/SKILL.md", body: bytes("---\nname: a\ndescription: da\n---") },
      { path: "a/x.md", body: bytes("x") },
      { path: "b/SKILL.md", body: bytes("---\nname: b\ndescription: db\n---") },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skills.map((s) => s.name).sort()).toEqual(["a", "b"]);
    const a = r.skills.find((s) => s.name === "a")!;
    // Child files are re-rooted to the Skill dir (SKILL.md at top).
    expect(a.files.map((f) => f.path).sort()).toEqual(["SKILL.md", "x.md"].sort());
  });

  it("keeps every file's bytes and decodes only SKILL.md", () => {
    // Not valid UTF-8: decoding and re-encoding would replace these bytes.
    const font = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0xff, 0xfe, 0xc3, 0x28, 0x80, 0x00]);
    const r = detectSkills([
      { path: "fonts/SKILL.md", body: bytes("---\nname: fonts\ndescription: Font assets\n---") },
      { path: "fonts/assets/Regular.ttf", body: font },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skills[0]).toMatchObject({ name: "fonts", description: "Font assets" });
    expect(r.skills[0].files.find((f) => f.path === "assets/Regular.ttf")?.body).toEqual(font);
  });

  it("no SKILL.md anywhere → reject", () => {
    const r = detectSkills([{ path: "readme.md", body: bytes("hi") }]);
    expect(r.ok).toBe(false);
  });

  it("ambiguous mix (root + child SKILL.md) → reject", () => {
    const r = detectSkills([
      { path: "SKILL.md", body: bytes(SKILL_MD) },
      { path: "child/SKILL.md", body: bytes("---\nname: c\ndescription: dc\n---") },
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
