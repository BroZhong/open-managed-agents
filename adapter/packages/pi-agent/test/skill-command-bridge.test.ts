import { describe, expect, it } from "vitest";
import type { SkillDescriptor } from "@open-managed-agents/adapter-core";
import {
  createManagedSkillCommandExtension,
  expandManagedSkillCommand,
} from "../src/skill-command-bridge.js";

const skills: SkillDescriptor[] = [
  {
    name: "storyboard",
    description: "Split a screenplay into storyboard shots.",
    path: "/skills/skill_fork_1/SKILL.md",
  },
];

describe("managed sandbox Skill command bridge", () => {
  it("turns /skill:name args into an explicit sandbox read instruction", () => {
    const expanded = expandManagedSkillCommand(
      "/skill:storyboard split the supplied scene",
      skills,
    );

    expect(expanded).toContain('explicitly invoked the equipped Skill "storyboard"');
    expect(expanded).toContain("/skills/skill_fork_1/SKILL.md");
    expect(expanded).toContain("must first use the `read` tool");
    expect(expanded).toContain("split the supplied scene");
    expect(expanded).not.toContain("Split a screenplay into storyboard shots.");
  });

  it("leaves ordinary prompts and unknown Skills unchanged", () => {
    expect(expandManagedSkillCommand("hello", skills)).toBe("hello");
    expect(expandManagedSkillCommand("/skill:missing args", skills)).toBe(
      "/skill:missing args",
    );
  });

  it("preserves multiline user arguments after the exact Skill name", () => {
    const expanded = expandManagedSkillCommand(
      "/skill:storyboard first line\nsecond line",
      skills,
    );

    expect(expanded).toContain("User arguments:\nfirst line\nsecond line");
  });

  it("registers an input transform on Pi's per-Turn extension bus", async () => {
    let inputHandler:
      | ((event: { text: string }) => Promise<unknown> | unknown)
      | undefined;
    createManagedSkillCommandExtension(skills)({
      on(event: string, handler: typeof inputHandler) {
        if (event === "input") inputHandler = handler;
      },
    } as never);

    expect(inputHandler).toBeDefined();
    await expect(
      Promise.resolve(inputHandler!({ text: "/skill:storyboard make shots" })),
    ).resolves.toMatchObject({
      action: "transform",
      text: expect.stringContaining("/skills/skill_fork_1/SKILL.md"),
    });
    await expect(
      Promise.resolve(inputHandler!({ text: "normal prompt" })),
    ).resolves.toEqual({ action: "continue" });
  });
});
