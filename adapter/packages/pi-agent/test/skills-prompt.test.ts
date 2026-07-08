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

  it("points the model at the read tool that our native factory exposes", () => {
    const section = buildSkillsPromptSection([skill()]);
    // Our custom tools use Pi's native factories, so the read tool is named
    // `read` — matching Pi's own "Use the read tool" wording verbatim.
    expect(section).toContain("the read tool");
  });

  it("excludes skills flagged disableModelInvocation", () => {
    const section = buildSkillsPromptSection([
      skill({ name: "hidden", disableModelInvocation: true }),
    ]);
    expect(section).toBe("");
  });
});
