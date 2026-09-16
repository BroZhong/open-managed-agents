import { useMemo } from "react";
import { FileManager } from "@/components/file-manager";
import { createWorkspaceFileSource } from "@/lib/file-source";

interface WorkspacePanelProps {
  workspaceId: string;
  workspaceName?: string;
  fileSelection?: { path: string; nonce: number };
  /** Bumped by Turn end to trigger an OSS file-list refetch. */
  refreshKey: number;
}

/** Files are scoped to the Workspace, independently of a Session's Turn. */
export function WorkspacePanel({ workspaceId, workspaceName, refreshKey, fileSelection }: WorkspacePanelProps) {
  const source = useMemo(() => createWorkspaceFileSource(workspaceId), [workspaceId]);
  return (
    <FileManager
      key={workspaceId}
      source={source}
      rootLabel={workspaceName || "Workspace"}
      fileSelection={fileSelection}
      presentation="workbench"
      turnStatus="idle"
      refreshKey={refreshKey}
      emptyHint="No files yet. Files created by the agent appear here."
    />
  );
}
