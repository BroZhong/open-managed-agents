import { useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
 * receives never gates its writes — we pass the constant `"idle"`. Text files
 * open in the editor; binary files (fonts, images, …) are previewed when they
 * are images, video or audio and otherwise offered as a download.
 */
export function SkillFilesEditor({ skillId, agentId, presentation = "default" }: { skillId: string; agentId?: string; presentation?: "default" | "workbench" }) {
  const queryClient = useQueryClient();
  const source = useMemo(() => createSkillFileSource(skillId, () => {
    void queryClient.invalidateQueries({ queryKey: ["skills"] });
    if (agentId) {
      void queryClient.invalidateQueries({ queryKey: ["agents", agentId, "skills"] });
    }
  }), [skillId, agentId, queryClient]);
  // Previews are object URLs of fetched bytes: release the last one on leave.
  useEffect(() => () => source.dispose(), [source]);
  return (
    <FileManager
      key={skillId}
      source={source}
      presentation={presentation}
      rootLabel="Skill"
      selectionHint="Browse this Skill to preview or edit its files."
      turnStatus="idle"
      emptyHint="No files."
    />
  );
}
