import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileManager } from "@/components/file-manager";
import { createWorkspaceFileSource } from "@/lib/file-source";

interface WorkspacePanelProps {
  workspaceId: string;
  workspaceName?: string;
  fileSelection?: { path: string; nonce: number };
  refreshKey: number;
  /** Counters belong to a Session; switching counter owners is not a change. */
  refreshScope?: string;
  active?: boolean;
}

/** Workspace state survives Session navigation, but never crosses Workspaces. */
export const WorkspacePanel = memo(function WorkspacePanel(props: WorkspacePanelProps) {
  return <WorkspaceFiles key={props.workspaceId} {...props} />;
});

function WorkspaceFiles({ workspaceId, workspaceName, refreshKey, refreshScope, fileSelection, active = true }: WorkspacePanelProps) {
  const client = useQueryClient();
  const source = useMemo(() => createWorkspaceFileSource(workspaceId), [workspaceId]);
  const queryKey = useMemo(() => ["workspace-files", workspaceId], [workspaceId]);
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => source.list({ signal }),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    enabled: active,
    retry: false,
  });
  const previous = useRef({ refreshKey, refreshScope });
  useEffect(() => {
    const ownerChanged = previous.current.refreshScope !== refreshScope;
    const changed = !ownerChanged && previous.current.refreshKey !== refreshKey;
    previous.current = { refreshKey, refreshScope };
    if (changed) {
      // Mark stale even while hidden. FileManager refreshes the tree and its
      // selected preview together when visible, using a post-change read.
      if (!active) void client.cancelQueries({ queryKey });
      void client.invalidateQueries({ queryKey, refetchType: "none" });
    } else if (ownerChanged && active) {
      // The observer survives same-Workspace navigation. Revalidate on return
      // only if its cached list is stale; fresh lists perform no network work.
      void client.fetchQuery({ queryKey, queryFn: ({ signal }) => source.list({ signal }), staleTime: 30_000 }).catch(() => undefined);
    }
  }, [client, queryKey, source, refreshKey, refreshScope, active]);
  const { refetch } = query;
  const refresh = useCallback(async (reuseInFlight = false) => {
    // Also fence an initial read with no cached data: it may have started
    // before a write/Turn completion and must not satisfy an explicit refresh.
    if (reuseInFlight) {
      return client.fetchQuery({ queryKey, queryFn: ({ signal }) => source.list({ signal }), staleTime: 30_000 });
    }
    await client.cancelQueries({ queryKey });
    const result = await refetch({ throwOnError: true });
    return result.data!;
  }, [client, queryKey, source, refetch]);
  // Let urgent composer updates commit before a new file tree is rendered.
  const nodes = useDeferredValue(query.data);
  const listing = useMemo(() => ({ nodes, active, loading: query.isFetching, error: query.error, refresh }), [nodes, active, query.isFetching, query.error, refresh]);
  return (
    <FileManager
      source={source}
      listing={listing}
      refreshKey={refreshKey}
      refreshScope={refreshScope}
      rootLabel={workspaceName || "Workspace"}
      fileSelection={fileSelection}
      presentation="workbench"
      turnStatus="idle"
      emptyHint="No files yet. Files created by the agent appear here."
    />
  );
}
