import { useMemo } from "react";
import { FileManager } from "@/components/file-manager";
import { createSkillFileSource } from "@/lib/file-source";

/**
 * Skill files editor — now a thin wrapper over the unified {@link FileManager}
 * (#103). It supplies a {@link createSkillFileSource} scoped by `skillId`, so
 * the same component edits a Library Skill on the Library page and an Agent's
 * fork on the Agent page — per ADR-0004 the fork is a separate id, so editing
 * it never touches the Library Skill.
 *
 * SkillFileSource is nested, writable (save/rename/delete/upload) and NOT
 * idle-gated (`capabilities.idleGated === false`), so the `turnStatus` a Skill
 * receives never gates its writes — we pass the constant `"idle"`. Skills are
 * text-only (no `previewUrl`), so binary files fall back to download.
 */
export function SkillFilesEditor({ skillId }: { skillId: string }) {
  const source = useMemo(() => createSkillFileSource(skillId), [skillId]);
  return <FileManager source={source} turnStatus="idle" emptyHint="No files." />;
}
