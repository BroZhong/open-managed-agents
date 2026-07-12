import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { SkillDescriptor } from "@open-managed-agents/adapter-core";

const SKILL_COMMAND = /^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/;

/**
 * Expand a Pi-style Skill command without reading sandbox files on the Host.
 * The transformed prompt makes the sandbox `read` call explicit, so Skill
 * loading remains observable as an ordinary tool call/result in the event log.
 */
export function expandManagedSkillCommand(
  text: string,
  descriptors: SkillDescriptor[],
): string {
  const match = text.match(SKILL_COMMAND);
  if (!match) return text;

  const descriptor = descriptors.find((skill) => skill.name === match[1]);
  if (!descriptor) return text;

  const args = match[2]?.trim() ?? "";
  const baseDir = descriptor.path.replace(/\/[^/]+$/, "");
  return [
    `The user explicitly invoked the equipped Skill "${descriptor.name}".`,
    `You must first use the \`read\` tool to load ${descriptor.path}.`,
    `Follow the loaded Skill instructions for this request. Resolve its relative references from ${baseDir}.`,
    "",
    "User arguments:",
    args || "(none)",
  ].join("\n");
}

/** Per-Turn Pi input bridge for Skills projected inside the managed sandbox. */
export function createManagedSkillCommandExtension(
  descriptors: SkillDescriptor[],
): ExtensionFactory {
  return (pi) => {
    pi.on("input", (event) => {
      const text = expandManagedSkillCommand(event.text, descriptors);
      return text === event.text
        ? { action: "continue" }
        : { action: "transform", text };
    });
  };
}
