import { useMemo } from "react";
import { FileManager } from "@/components/file-manager";
import { createWorkspaceFileSource } from "@/lib/file-source";
import type { TurnStatus } from "@/lib/file-source";

interface WorkspacePanelProps {
  sessionId: string;
  /** Bumped by the file-change SSE event and turn end to trigger a refetch. */
  refreshKey: number;
  /**
   * Turn state from the host page's SSE (session-detail's `useSessionEvents`).
   * Drives the Workspace's idle-gate: writes are disabled while `"running"`.
   */
  turnStatus: TurnStatus;
}

/**
 * Workspace panel — now a thin wrapper over the unified {@link FileManager}
 * (#102). It supplies a {@link createWorkspaceFileSource} and forwards the
 * host's turn status; FileManager derives the entire UI (tree / editor / media
 * preview / upload / button gating) from that source's capabilities. The old
 * read-only tree + PreviewPane lived here; that logic now lives once, in
 * FileManager, driven by the FileSource abstraction.
 */
export function WorkspacePanel({ sessionId, refreshKey, turnStatus }: WorkspacePanelProps) {
  const source = useMemo(() => createWorkspaceFileSource(sessionId), [sessionId]);
  return (
    <FileManager
      key={sessionId}
      source={source}
      turnStatus={turnStatus}
      refreshKey={refreshKey}
      emptyHint="No files yet. Files created by the agent appear here."
    />
  );
}
