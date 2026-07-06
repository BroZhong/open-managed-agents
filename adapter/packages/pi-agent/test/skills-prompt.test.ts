import { describe, it, expect } from "vitest";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { buildSkillsPromptSection } from "../src/pi-agent-adapter.js";

function skill(over: Partial<Skill> = {}): Skill {
  return {
    name: "teach",
    description: "Teach the user a new skill or concept.",
    filePath: "/tmp/oma-skills-x/skill_abc/SKILL.md",
    disableModelInvocation: false,
    ...over,
  } as Skill;
}

describe("buildSkillsPromptSection (skills invisible-at-runtime fix)", () => {
  it("returns empty string when there are no skills", () => {
    expect(buildSkillsPromptSection([])).toBe("");
  });

  it("lists an equipped skill's name, description and location", () => {
    const section = buildSkillsPromptSection([skill()]);
    expect(section).toContain("<available_skills>");
    expect(section).toContain("<name>teach</name>");
    expect(section).toContain("Teach the user a new skill or concept.");
    expect(section).toContain("/tmp/oma-skills-x/skill_abc/SKILL.md");
  });

  it("points the model at the read_file tool, not Pi's builtin read tool", () => {
    const section = buildSkillsPromptSection([skill()]);
    // Our custom-tool runtime exposes `read_file`, not `read`; the wording must
    // reference the tool that actually exists so the model can load the skill.
    expect(section).toContain("the read_file tool");
    expect(section).not.toMatch(/\bthe read tool\b/);
  });

  it("excludes skills flagged disableModelInvocation", () => {
    const section = buildSkillsPromptSection([
      skill({ name: "hidden", disableModelInvocation: true }),
    ]);
    expect(section).toBe("");
  });
});
